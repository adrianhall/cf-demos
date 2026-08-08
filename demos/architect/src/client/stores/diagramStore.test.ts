import type { Edge, Node } from "@xyflow/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CFEdgeData, CFNodeData } from "../components/editor/types";
import { useDiagramStore } from "./diagramStore";

/** A minimal, valid node for store tests. */
function makeNode(id: string, typeId = "worker"): Node<CFNodeData> {
  return {
    data: { label: typeId, typeId },
    id,
    position: { x: 0, y: 0 },
    type: "cf-node",
  };
}

describe("useDiagramStore", () => {
  beforeEach(() => {
    useDiagramStore.setState({
      diagramId: null,
      title: "Untitled Diagram",
      description: "",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      saveError: null,
      undoStack: [],
      redoStack: [],
    });
  });

  it("initialises from setDiagram and clears dirty/history", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    useDiagramStore
      .getState()
      .setDiagram(
        "diagram-1",
        "My Diagram",
        "A description",
        [makeNode("b")],
        [],
        { x: 1, y: 2, zoom: 1.5 },
      );

    const state = useDiagramStore.getState();
    expect(state.diagramId).toBe("diagram-1");
    expect(state.title).toBe("My Diagram");
    expect(state.description).toBe("A description");
    expect(state.nodes).toHaveLength(1);
    expect(state.dirty).toBe(false);
    expect(state.undoStack).toHaveLength(0);
  });

  it("adds a node, marks dirty, and pushes undo history", () => {
    useDiagramStore.getState().addNode(makeNode("a"));

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.dirty).toBe(true);
    expect(state.undoStack).toHaveLength(1);
  });

  it("undoes and redoes an add", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    useDiagramStore.getState().undo();
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
    expect(useDiagramStore.getState().redoStack).toHaveLength(1);

    useDiagramStore.getState().redo();
    expect(useDiagramStore.getState().nodes).toHaveLength(1);
  });

  it("no-ops undo when the history stack is empty", () => {
    useDiagramStore.getState().undo();
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("no-ops redo when the redo stack is empty", () => {
    useDiagramStore.getState().redo();
    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  it("merges partial data into a node via updateNodeData", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    useDiagramStore.getState().updateNodeData("a", { label: "Renamed" });

    expect(useDiagramStore.getState().nodes[0]?.data.label).toBe("Renamed");
  });

  it("merges partial data into an edge via updateEdgeData", () => {
    useDiagramStore.setState({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "a",
          target: "b",
        } as Edge<CFEdgeData>,
      ],
    });

    useDiagramStore.getState().updateEdgeData("e1", { label: "New label" });

    expect(useDiagramStore.getState().edges[0]?.data?.label).toBe("New label");
  });

  it("applies node position changes without pushing undo history", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    const historyBefore = useDiagramStore.getState().undoStack.length;

    useDiagramStore
      .getState()
      .onNodesChange([{ id: "a", position: { x: 5, y: 5 }, type: "position" }]);

    const state = useDiagramStore.getState();
    expect(state.nodes[0]?.position).toEqual({ x: 5, y: 5 });
    expect(state.undoStack).toHaveLength(historyBefore);
  });

  it("pushes undo history for a structural (remove) node change", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    useDiagramStore.setState({ undoStack: [] });

    useDiagramStore.getState().onNodesChange([{ id: "a", type: "remove" }]);

    const state = useDiagramStore.getState();
    expect(state.nodes).toHaveLength(0);
    expect(state.undoStack).toHaveLength(1);
  });

  it("applies edge changes and pushes history only for structural changes", () => {
    useDiagramStore.setState({
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      undoStack: [],
    });

    useDiagramStore.getState().onEdgesChange([{ id: "e1", type: "remove" }]);

    const state = useDiagramStore.getState();
    expect(state.edges).toHaveLength(0);
    expect(state.undoStack).toHaveLength(1);
  });

  it("updates the viewport without marking dirty or pushing history", () => {
    useDiagramStore.getState().onViewportChange({ x: 10, y: 20, zoom: 2 });

    const state = useDiagramStore.getState();
    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(state.dirty).toBe(false);
  });

  it("creates a data-flow edge on connect", () => {
    useDiagramStore.getState().onConnect({
      source: "a",
      sourceHandle: null,
      target: "b",
      targetHandle: null,
    });

    const edges = useDiagramStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]?.data).toEqual({ edgeType: "data-flow" });
  });

  it("removes only selected nodes and edges", () => {
    useDiagramStore.setState({
      nodes: [
        { ...makeNode("a"), selected: true },
        { ...makeNode("b"), selected: false },
      ],
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          selected: true,
          source: "a",
          target: "b",
        } as Edge<CFEdgeData>,
        {
          data: { edgeType: "data-flow" },
          id: "e2",
          selected: false,
          source: "b",
          target: "a",
        } as Edge<CFEdgeData>,
      ],
    });

    useDiagramStore.getState().removeSelected();

    const state = useDiagramStore.getState();
    expect(state.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(state.edges.map((e) => e.id)).toEqual(["e2"]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.selectedEdgeId).toBeNull();
  });

  it("tracks a single selection at a time between nodes and edges", () => {
    useDiagramStore.getState().setSelectedNode("a");
    expect(useDiagramStore.getState().selectedNodeId).toBe("a");

    useDiagramStore.getState().setSelectedEdge("e1");
    expect(useDiagramStore.getState().selectedEdgeId).toBe("e1");
    expect(useDiagramStore.getState().selectedNodeId).toBeNull();
  });

  it("marks dirty when the title or description changes", () => {
    useDiagramStore.getState().setTitle("New Title");
    expect(useDiagramStore.getState().title).toBe("New Title");
    expect(useDiagramStore.getState().dirty).toBe(true);

    useDiagramStore.setState({ dirty: false });
    useDiagramStore.getState().setDescription("New description");
    expect(useDiagramStore.getState().dirty).toBe(true);
  });

  it("tracks saving/saved/error transitions", () => {
    useDiagramStore.getState().markSaving();
    expect(useDiagramStore.getState().saving).toBe(true);

    useDiagramStore.getState().markSaved();
    let state = useDiagramStore.getState();
    expect(state.saving).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.lastSavedAt).not.toBeNull();

    useDiagramStore.getState().markSaveError("Network error");
    state = useDiagramStore.getState();
    expect(state.saving).toBe(false);
    expect(state.saveError).toBe("Network error");
  });

  it("caps the undo stack at 50 entries", () => {
    for (let i = 0; i < 60; i += 1) {
      useDiagramStore.getState().addNode(makeNode(`n${i}`));
    }
    expect(useDiagramStore.getState().undoStack).toHaveLength(50);
  });

  it("replaces the whole nodes/edges arrays via setNodes/setEdges", () => {
    useDiagramStore.getState().setNodes([makeNode("z")]);
    useDiagramStore.getState().setEdges([]);
    expect(useDiagramStore.getState().nodes.map((n) => n.id)).toEqual(["z"]);
  });
});
