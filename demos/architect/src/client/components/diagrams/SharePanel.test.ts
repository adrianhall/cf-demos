import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramShareStore } from "../../stores/diagram-share";
import SharePanel from "./SharePanel.vue";

/** Small DOM-focused Vuetify substitutes, matching this repo's established stubbing pattern. */
const stubs = {
  FeatherIcon: true,
  VDialog: {
    props: ["modelValue"],
    template: '<div v-if="modelValue"><slot /></div>',
  },
  VCard: { template: "<section><slot /></section>" },
  VCardText: { template: "<div><slot /></div>" },
  VCardActions: { template: "<div><slot /></div>" },
  VSpacer: { template: "<span />" },
  VAlert: { template: "<div><slot /></div>" },
  VProgressCircular: { template: "<div />" },
  VBtn: {
    props: ["loading"],
    template:
      '<button v-bind="$attrs" :disabled="loading"><slot name="prepend" /><slot /></button>',
  },
};

function mountPanel(initialState: Record<string, unknown> = {}) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { "diagram-share": initialState },
    stubActions: false,
  });
  const wrapper = mount(SharePanel, {
    global: { plugins: [pinia], stubs },
    props: { diagramId: "diagram-1", open: true },
  });
  return { store: useDiagramShareStore(), wrapper };
}

function findButton(
  wrapper: ReturnType<typeof mountPanel>["wrapper"],
  text: string,
) {
  const button = wrapper
    .findAll("button")
    .find((candidate) => candidate.text().includes(text));
  if (!button) {
    throw new Error(`No button contains text: ${text}`);
  }
  return button;
}

/** Wait for pending microtasks (store async actions) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => vi.unstubAllGlobals());

describe("SharePanel", () => {
  it("publishes a diagram and shows its one-time copy link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            published: true,
            revision: 3,
            token: "raw-token-value",
          }),
          { status: 200 },
        ),
      ),
    );
    const { wrapper } = mountPanel();

    await findButton(wrapper, "Publish this diagram").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("/share#raw-token-value");
  });

  it("republishing an already-published diagram shows no new token but stays published", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ published: true, revision: 4, token: null }),
            { status: 200 },
          ),
        ),
    );
    const { wrapper } = mountPanel({
      status: { published: true, revision: 3 },
    });

    await findButton(wrapper, "Republish current version").trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("/share#");
    expect(wrapper.text()).toContain("revision 4");
  });

  it("copies the current share link to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { wrapper } = mountPanel({ lastToken: "raw-token-value" });

    await findButton(wrapper, "Copy link").trigger("click");

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/share#raw-token-value"),
    );
  });

  it("revokes an active share", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    const { wrapper } = mountPanel({
      status: { published: true, revision: 1 },
      lastToken: "raw-token-value",
    });

    expect(wrapper.text()).toContain("Revoke published link");
    await findButton(wrapper, "Revoke published link").trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("Revoke published link");
  });

  it("shows a store error message", () => {
    const { wrapper } = mountPanel({
      error: "Only the diagram's owner can do this.",
    });
    expect(wrapper.text()).toContain("Only the diagram's owner can do this.");
  });
});
