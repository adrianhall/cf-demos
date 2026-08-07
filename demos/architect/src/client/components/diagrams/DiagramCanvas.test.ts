import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../../../graph/types";
import DiagramCanvas from "./DiagramCanvas.vue";

/**
 * Stub Vue Flow entirely (no real canvas layout in jsdom, matching
 * `spikes/06-architect-vue-editor/REPORT.md`'s own decision not to exercise real Vue Flow
 * rendering in an automated test) while still exercising `DiagramCanvas.vue`'s own event
 * adapter logic — the actual code this repository authored.
 */
const vueFlowStub = {
  emits: ["nodeClick", "edgeClick", "nodeDragStop", "connect", "paneClick"],
  props: ["nodesConnectable", "nodesDraggable"],
  template: "<div><slot /></div>",
};

const document: GraphDocument = {
  version: 1,
  nodes: [
    {
      id: "a",
      type: "actor",
      position: { x: 0, y: 0 },
      data: { kind: "external-actor", label: "A" },
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "a",
      target: "a",
      type: "request",
      data: { relationship: "request", label: "x" },
    },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function mountCanvas(readOnly = false) {
  return mount(DiagramCanvas, {
    props: { edges: document.edges, nodes: document.nodes, readOnly },
    global: {
      stubs: {
        Background: true,
        Controls: true,
        VueFlow: vueFlowStub,
      },
    },
  });
}

describe("DiagramCanvas", () => {
  it("emits selectNode from a Vue Flow node click", async () => {
    const wrapper = mountCanvas();
    await wrapper
      .findComponent(vueFlowStub)
      .vm.$emit("nodeClick", { node: { id: "a" } });
    expect(wrapper.emitted("selectNode")).toEqual([["a"]]);
  });

  it("emits selectEdge from a Vue Flow edge click", async () => {
    const wrapper = mountCanvas();
    await wrapper
      .findComponent(vueFlowStub)
      .vm.$emit("edgeClick", { edge: { id: "edge-1" } });
    expect(wrapper.emitted("selectEdge")).toEqual([["edge-1"]]);
  });

  it("emits moveNode with only the final drag position", async () => {
    const wrapper = mountCanvas();
    await wrapper.findComponent(vueFlowStub).vm.$emit("nodeDragStop", {
      node: { id: "a", position: { x: 42, y: 24 } },
    });
    expect(wrapper.emitted("moveNode")).toEqual([["a", { x: 42, y: 24 }]]);
  });

  it("emits connectNodes from a Vue Flow connect event", async () => {
    const wrapper = mountCanvas();
    const connection = { source: "a", target: "b" };
    await wrapper.findComponent(vueFlowStub).vm.$emit("connect", connection);
    expect(wrapper.emitted("connectNodes")).toEqual([[connection]]);
  });

  it("emits clearSelection from a pane click", async () => {
    const wrapper = mountCanvas();
    await wrapper.findComponent(vueFlowStub).vm.$emit("paneClick");
    expect(wrapper.emitted("clearSelection")).toHaveLength(1);
  });

  it("disables dragging and connecting in read-only mode while leaving selection enabled", () => {
    const wrapper = mountCanvas(true);
    const flow = wrapper.findComponent(vueFlowStub);
    expect(flow.props("nodesDraggable")).toBe(false);
    expect(flow.props("nodesConnectable")).toBe(false);
  });

  it("enables dragging and connecting outside read-only mode", () => {
    const wrapper = mountCanvas(false);
    const flow = wrapper.findComponent(vueFlowStub);
    expect(flow.props("nodesDraggable")).toBe(true);
    expect(flow.props("nodesConnectable")).toBe(true);
  });
});
