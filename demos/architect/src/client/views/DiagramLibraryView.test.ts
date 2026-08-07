import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useDiagramsStore } from "../stores/diagrams";
import { useSessionStore } from "../stores/session";
import DiagramLibraryView from "./DiagramLibraryView.vue";

const pushMock = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push: pushMock }) }));

const stubs = {
  FeatherIcon: true,
  RouterLink: { props: ["to"], template: "<a><slot /></a>" },
  VContainer: { template: "<div><slot /></div>" },
  VAlert: { template: "<div><slot /></div>" },
  VProgressCircular: { template: "<div />" },
  VCard: { template: "<section><slot /></section>" },
  VCardText: { template: "<div><slot /></div>" },
  VList: { template: "<div><slot /></div>" },
  VListItem: {
    template:
      '<div><slot name="title" /><slot name="subtitle" /><slot name="append" /></div>',
  },
  VTextField: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template:
      '<input class="title-field" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  VRadioGroup: { template: "<div><slot /></div>" },
  VRadio: {
    props: ["label", "value"],
    template: "<button>{{ label }}</button>",
  },
  VDialog: {
    props: ["modelValue"],
    template: '<div v-if="modelValue"><slot /></div>',
  },
  VCardActions: { template: "<div><slot /></div>" },
  VSpacer: { template: "<span />" },
  VBtn: {
    props: ["disabled"],
    template:
      '<button v-bind="$attrs" :disabled="disabled"><slot name="prepend" /><slot /></button>',
  },
};

function mountLibrary() {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const wrapper = mount(DiagramLibraryView, {
    global: { plugins: [pinia], stubs },
  });
  return {
    diagrams: useDiagramsStore(),
    session: useSessionStore(),
    wrapper,
  };
}

function findButton(
  wrapper: ReturnType<typeof mountLibrary>["wrapper"],
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

describe("DiagramLibraryView", () => {
  it("creates a diagram from the dialog and navigates to its editor", async () => {
    const created = {
      id: "new-diagram-id",
      ownerEmail: "owner@example.com",
      title: "My diagram",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ email: "owner@example.com" })),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ diagrams: [] })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ diagram: created }), { status: 201 }),
        ),
    );
    const { wrapper } = mountLibrary();
    await wrapper.vm.$nextTick();
    await flushPromises();

    await findButton(wrapper, "New diagram").trigger("click");
    await wrapper.get("input.title-field").setValue("My diagram");
    const createButtons = wrapper
      .findAll("button")
      .filter((button) => button.text() === "Create");
    await createButtons[createButtons.length - 1].trigger("click");
    await flushPromises();

    expect(pushMock).toHaveBeenCalledWith({
      name: "diagram-editor",
      params: { id: "new-diagram-id" },
    });
    vi.unstubAllGlobals();
  });
});

/** Wait for pending microtasks (store async actions) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
