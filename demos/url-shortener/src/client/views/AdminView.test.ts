import { createTestingPinia } from "@pinia/testing";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVuetify } from "vuetify";
import {
  VAlert,
  VBtn,
  VCard,
  VCardActions,
  VCardText,
  VChip,
  VContainer,
  VDialog,
  VList,
  VListItem,
  VProgressCircular,
  VSpacer,
  VTextField,
} from "vuetify/components";
import { Ripple } from "vuetify/directives";
import { type ShortLink, useLinksStore } from "../stores/links";
import AdminView from "./AdminView.vue";

const vuetify = createVuetify({
  components: {
    VAlert,
    VBtn,
    VCard,
    VCardActions,
    VCardText,
    VChip,
    VContainer,
    VDialog,
    VList,
    VListItem,
    VProgressCircular,
    VSpacer,
    VTextField,
  },
  directives: { Ripple },
});

/** Store instance whose actions are replaced with Vitest spies by testing Pinia. */
type TestingLinksStore = ReturnType<typeof useLinksStore>;

/** Values returned from mounting the administrator view for one isolated test. */
interface MountedAdminView {
  /** Testing Pinia store used by the mounted component. */
  store: TestingLinksStore;
  /** Vue Test Utils wrapper for the mounted component. */
  wrapper: ReturnType<typeof mount>;
}

/** Mount the administrator view with mocked store actions and optional initial state. */
function mountAdminView(
  links: ShortLink[] = [],
  loading = false,
  prepareStore?: (store: TestingLinksStore) => void,
): MountedAdminView {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { links: { links, loading } },
    stubActions: true,
  });
  setActivePinia(pinia);
  const store = useLinksStore(pinia);
  prepareStore?.(store);

  return {
    store,
    wrapper: mount(AdminView, {
      attachTo: document.body,
      global: {
        plugins: [pinia, vuetify],
        stubs: {
          VDialog: {
            emits: ["update:modelValue"],
            name: "VDialog",
            props: ["modelValue"],
            template:
              '<div v-if="modelValue" class="test-dialog"><slot /></div>',
          },
        },
      },
    }),
  };
}

const exampleLink: ShortLink = {
  code: "demo-code",
  createdAt: "2026-07-24T10:00:00.000Z",
  destination: "https://example.com/original",
  updatedAt: "2026-07-24T11:00:00.000Z",
};

enableAutoUnmount(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminView", () => {
  it("loads links on mount and renders the empty state", () => {
    const { store, wrapper } = mountAdminView();

    expect(store.load).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain("No links yet");
  });

  it("renders the loading state", () => {
    const { wrapper } = mountAdminView([], true);

    expect(
      wrapper.get('[aria-label="Loading links"]').attributes("aria-label"),
    ).toBe("Loading links");
  });

  it("renders populated links", () => {
    const { wrapper } = mountAdminView([exampleLink]);
    const publicUrl = new URL(
      `/l/${exampleLink.code}`,
      window.location.origin,
    ).toString();

    expect(wrapper.get('[aria-label="Managed short links"]').text()).toContain(
      exampleLink.destination,
    );
    expect(wrapper.get(`a[href="/l/${exampleLink.code}"]`).text()).toBe(
      publicUrl,
    );
  });

  it.each([
    [new Error("Load failed"), "Load failed"],
    ["unexpected", "Could not load short links."],
  ])("reports an initial load failure", async (failure, expectedMessage) => {
    const { wrapper } = mountAdminView([], false, (store) => {
      vi.mocked(store.load).mockRejectedValue(failure);
    });
    await flushPromises();

    expect(wrapper.text()).toContain(expectedMessage);
  });

  it("creates a link and resets the create form", async () => {
    const { store, wrapper } = mountAdminView();
    vi.mocked(store.create).mockResolvedValue(exampleLink);
    const input = wrapper.get('input[type="url"]');

    await input.setValue(exampleLink.destination);
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(store.create).toHaveBeenCalledWith(exampleLink.destination);
    expect(wrapper.get("form").classes()).toEqual(
      expect.arrayContaining([
        "d-flex",
        "flex-column",
        "flex-sm-row",
        "align-start",
        "ga-3",
      ]),
    );
    expect(input.element.closest(".v-text-field")?.classList).toContain(
      "flex-grow-1",
    );
    expect(wrapper.get('button[type="submit"]').classes()).not.toContain(
      "mt-4",
    );
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).toContain(
      `Created ${window.location.origin}/l/${exampleLink.code}`,
    );
  });

  it.each([
    [new Error("Create failed"), "Create failed"],
    ["unexpected", "Could not create the short link."],
  ])("reports a create failure", async (failure, expectedMessage) => {
    const { store, wrapper } = mountAdminView();
    vi.mocked(store.create).mockRejectedValue(failure);

    await wrapper.get('input[type="url"]').setValue(exampleLink.destination);
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain(expectedMessage);
  });

  it("copies the public URL and marks the copied link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { wrapper } = mountAdminView([exampleLink]);

    await wrapper
      .get(`[aria-label="Copy ${exampleLink.code}"]`)
      .trigger("click");
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/l/${exampleLink.code}`,
    );
    expect(wrapper.text()).toContain("Copied");
    expect(wrapper.text()).toContain("Short URL copied to the clipboard.");
  });

  it("requires confirmation before deleting a link", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { store, wrapper } = mountAdminView([exampleLink]);

    await wrapper
      .get(`[aria-label="Delete ${exampleLink.code}"]`)
      .trigger("click");

    expect(confirm).toHaveBeenCalledOnce();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("deletes a confirmed link", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { store, wrapper } = mountAdminView([exampleLink]);
    vi.mocked(store.delete).mockResolvedValue(undefined);

    await wrapper
      .get(`[aria-label="Delete ${exampleLink.code}"]`)
      .trigger("click");
    await flushPromises();

    expect(store.delete).toHaveBeenCalledWith(exampleLink.code);
    expect(wrapper.text()).toContain("Short link deleted.");
  });

  it.each([
    [new Error("Delete failed"), "Delete failed"],
    ["unexpected", "Could not delete the short link."],
  ])("reports a delete failure", async (failure, expectedMessage) => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { store, wrapper } = mountAdminView([exampleLink]);
    vi.mocked(store.delete).mockRejectedValue(failure);

    await wrapper
      .get(`[aria-label="Delete ${exampleLink.code}"]`)
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain(expectedMessage);
  });

  it("edits a destination and closes the dialog after success", async () => {
    const { store, wrapper } = mountAdminView([exampleLink]);
    vi.mocked(store.update).mockResolvedValue({
      ...exampleLink,
      destination: "https://example.com/updated",
    });

    await wrapper
      .get(`[aria-label="Edit ${exampleLink.code}"]`)
      .trigger("click");
    const inputs = wrapper.findAll('input[type="url"]');
    expect(inputs).toHaveLength(2);
    expect((inputs[1].element as HTMLInputElement).value).toBe(
      exampleLink.destination,
    );

    await inputs[1].setValue("https://example.com/updated");
    await wrapper.get(".test-dialog button:last-of-type").trigger("click");
    await flushPromises();

    expect(store.update).toHaveBeenCalledWith(
      exampleLink.code,
      "https://example.com/updated",
    );
    expect(wrapper.text()).toContain("Destination updated.");
    expect(wrapper.find(".test-dialog").exists()).toBe(false);
  });

  it.each([
    [new Error("Update failed"), "Update failed"],
    ["unexpected", "Could not update the short link."],
  ])(
    "keeps the edit dialog open when updating fails",
    async (failure, expectedMessage) => {
      const { store, wrapper } = mountAdminView([exampleLink]);
      vi.mocked(store.update).mockRejectedValue(failure);

      await wrapper
        .get(`[aria-label="Edit ${exampleLink.code}"]`)
        .trigger("click");
      await wrapper.get(".test-dialog button:last-of-type").trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain(expectedMessage);
      expect(wrapper.find(".test-dialog").exists()).toBe(true);
    },
  );

  it("closes status messages and the edit dialog", async () => {
    const { wrapper } = mountAdminView([], false, (store) => {
      vi.mocked(store.load).mockRejectedValue(new Error("Load failed"));
    });
    await flushPromises();

    wrapper.getComponent(VAlert).vm.$emit("click:close");
    await nextTick();
    expect(wrapper.text()).not.toContain("Load failed");

    const populated = mountAdminView([exampleLink]);
    await populated.wrapper
      .get(`[aria-label="Edit ${exampleLink.code}"]`)
      .trigger("click");
    populated.wrapper
      .getComponent({ name: "VDialog" })
      .vm.$emit("update:modelValue", false);
    await nextTick();
    expect(populated.wrapper.find(".test-dialog").exists()).toBe(false);

    await populated.wrapper
      .get(`[aria-label="Edit ${exampleLink.code}"]`)
      .trigger("click");
    const cancel = populated.wrapper
      .findAll(".test-dialog button")
      .find((button) => button.text() === "Cancel");
    expect(cancel).toBeDefined();
    await cancel?.trigger("click");
    expect(populated.wrapper.find(".test-dialog").exists()).toBe(false);
  });
});
