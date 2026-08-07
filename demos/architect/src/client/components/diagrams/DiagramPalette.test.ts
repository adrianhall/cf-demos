import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useDiagramDocumentStore } from "../../stores/diagram-document";
import DiagramPalette from "./DiagramPalette.vue";

/** Small DOM-focused Vuetify substitutes, matching this repo's established stubbing pattern. */
const stubs = {
  FeatherIcon: true,
  VTextField: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template:
      '<div><slot name="prepend-inner" /><input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></div>',
  },
  VList: { template: "<div><slot /></div>" },
  VListItem: {
    props: ["disabled", "subtitle"],
    template:
      '<button v-bind="$attrs" :disabled="disabled"><slot name="prepend" /><slot name="title" /><slot /></button>',
  },
  VBtn: {
    props: ["disabled"],
    template:
      '<button v-bind="$attrs" :disabled="disabled"><slot name="prepend" /><slot /></button>',
  },
};

/** Mount the palette with a spy-backed store so actions can be asserted without real fetch calls. */
function mountPalette(nodeCount = 0) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: {
      "diagram-document": {
        document: {
          version: 1,
          nodes: Array(nodeCount).fill(null),
          edges: [],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        pending: false,
      },
    },
  });
  const wrapper = mount(DiagramPalette, {
    global: { plugins: [pinia], stubs },
  });
  return { store: useDiagramDocumentStore(), wrapper };
}

function findButton(
  wrapper: ReturnType<typeof mountPalette>["wrapper"],
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

describe("DiagramPalette", () => {
  it("adds a product node at a staggered position", async () => {
    const { store, wrapper } = mountPalette(2);
    await findButton(wrapper, "Workers").trigger("click");
    expect(store.addNode).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "product",
        position: { x: 120 + 2 * 220, y: 100 },
        data: expect.objectContaining({
          productId: "workers",
          label: "Workers",
        }),
      }),
    );
  });

  it("filters the catalog by search text", async () => {
    const { wrapper } = mountPalette();
    await wrapper.get("input").setValue("workflows");
    expect(wrapper.text()).toContain("Workflows");
    expect(wrapper.text()).not.toContain("Relational data");
  });

  it("adds an external actor node", async () => {
    const { store, wrapper } = mountPalette();
    await findButton(wrapper, "Add external actor").trigger("click");
    expect(store.addNode).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "actor",
        data: { kind: "external-actor", label: "External actor" },
      }),
    );
  });
});
