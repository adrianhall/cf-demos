import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { GraphDocument } from "../../../graph/types";
import { useDiagramDocumentStore } from "../../stores/diagram-document";
import PropertiesPanel from "./PropertiesPanel.vue";

const stubs = {
  FeatherIcon: true,
  VTextField: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template:
      '<input class="text-field" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  VTextarea: {
    emits: ["update:modelValue"],
    props: ["modelValue"],
    template:
      '<textarea class="textarea" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)"></textarea>',
  },
  VBtn: {
    template:
      '<button v-bind="$attrs"><slot name="prepend" /><slot /></button>',
  },
};

const document: GraphDocument = {
  version: 1,
  nodes: [
    {
      id: "workers-1",
      type: "product",
      position: { x: 0, y: 0 },
      data: {
        productId: "workers",
        label: "Workers",
        description: "Handles requests",
      },
    },
    {
      id: "actor-1",
      type: "actor",
      position: { x: 100, y: 0 },
      data: { kind: "external-actor", label: "Browser" },
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "actor-1",
      target: "workers-1",
      type: "request",
      data: { relationship: "request", label: "HTTPS request" },
    },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function mountPanel(selection: { kind: "node" | "edge"; id: string } | null) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { "diagram-document": { document, selection } },
  });
  const wrapper = mount(PropertiesPanel, {
    global: { plugins: [pinia], stubs },
  });
  return { store: useDiagramDocumentStore(), wrapper };
}

describe("PropertiesPanel", () => {
  it("shows a prompt when nothing is selected", () => {
    const { wrapper } = mountPanel(null);
    expect(wrapper.text()).toContain("Select a node or edge");
  });

  it("edits a product node's label and description", async () => {
    const { store, wrapper } = mountPanel({ kind: "node", id: "workers-1" });

    await wrapper.get("input.text-field").setValue("Renamed");
    expect(store.updateNode).toHaveBeenCalledWith("workers-1", {
      productId: "workers",
      label: "Renamed",
      description: "Handles requests",
    });

    await wrapper.get("textarea.textarea").setValue("New description");
    expect(store.updateNode).toHaveBeenCalledWith("workers-1", {
      productId: "workers",
      label: "Workers",
      description: "New description",
    });
  });

  it("edits an actor node's label", async () => {
    const { store, wrapper } = mountPanel({ kind: "node", id: "actor-1" });
    await wrapper.get("input.text-field").setValue("Customer");
    expect(store.updateNode).toHaveBeenCalledWith("actor-1", {
      kind: "external-actor",
      label: "Customer",
    });
  });

  it("deletes the selected node", async () => {
    const { store, wrapper } = mountPanel({ kind: "node", id: "workers-1" });
    await wrapper.get("button").trigger("click");
    expect(store.deleteNode).toHaveBeenCalledWith("workers-1");
  });

  it("shows edge details read-only and deletes the selected edge", async () => {
    const { store, wrapper } = mountPanel({ kind: "edge", id: "edge-1" });
    expect(wrapper.text()).toContain("request");
    expect(wrapper.text()).toContain("HTTPS request");
    await wrapper.get("button").trigger("click");
    expect(store.deleteEdge).toHaveBeenCalledWith("edge-1");
  });
});
