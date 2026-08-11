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
      ownerEmail: null,
      title: "Untitled Diagram",
      description: "",
      updatedAt: null,
      liveUpdateNotice: null,
      pendingOperations: new Map(),
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      saveError: null,
      paletteOpen: true,
      propertiesOpen: false,
      minimapOpen: true,
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
        "owner@example.com",
        "My Diagram",
        "A description",
        [makeNode("b")],
        [],
        { x: 1, y: 2, zoom: 1.5 },
        "2026-01-01T00:00:00.000Z",
      );

    const state = useDiagramStore.getState();
    expect(state.diagramId).toBe("diagram-1");
    expect(state.ownerEmail).toBe("owner@example.com");
    expect(state.title).toBe("My Diagram");
    expect(state.description).toBe("A description");
    expect(state.updatedAt).toBe("2026-01-01T00:00:00.000Z");
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

  it("leaves every other node untouched when updating one node's data", () => {
    useDiagramStore.getState().addNode(makeNode("a"));
    const untouched = makeNode("b");
    useDiagramStore.getState().addNode(untouched);

    useDiagramStore.getState().updateNodeData("a", { label: "Renamed" });

    const nodes = useDiagramStore.getState().nodes;
    expect(nodes.find((n) => n.id === "b")?.data).toEqual(untouched.data);
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

  it("leaves every other edge untouched when updating one edge's data", () => {
    const untouchedEdge = {
      data: { edgeType: "data-flow" },
      id: "e2",
      source: "b",
      target: "c",
    } as Edge<CFEdgeData>;
    useDiagramStore.setState({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "a",
          target: "b",
        } as Edge<CFEdgeData>,
        untouchedEdge,
      ],
    });

    useDiagramStore.getState().updateEdgeData("e1", { label: "New label" });

    const edges = useDiagramStore.getState().edges;
    expect(edges.find((e) => e.id === "e2")?.data).toEqual(untouchedEdge.data);
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

  it("pushes undo history for a structural (add) edge change", () => {
    useDiagramStore.setState({ edges: [], undoStack: [] });
    const added = {
      data: { edgeType: "data-flow" },
      id: "e1",
      source: "a",
      target: "b",
    } as Edge<CFEdgeData>;

    useDiagramStore.getState().onEdgesChange([{ item: added, type: "add" }]);

    const state = useDiagramStore.getState();
    expect(state.edges).toHaveLength(1);
    expect(state.undoStack).toHaveLength(1);
  });

  it("applies a non-structural edge change without pushing undo history", () => {
    useDiagramStore.setState({
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      undoStack: [],
    });

    useDiagramStore
      .getState()
      .onEdgesChange([{ id: "e1", selected: true, type: "select" }]);

    expect(useDiagramStore.getState().undoStack).toHaveLength(0);
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

  describe("connectNodes (Bug 8)", () => {
    beforeEach(() => {
      useDiagramStore.setState({
        nodes: [
          { ...makeNode("a"), position: { x: 0, y: 0 } },
          { ...makeNode("b"), position: { x: 300, y: 0 } },
        ],
      });
    });

    it("creates an edge with resolved handles, pushes history, marks dirty, and selects the new edge", () => {
      const newId = useDiagramStore
        .getState()
        .connectNodes("a", "b", "data-flow");

      const state = useDiagramStore.getState();
      expect(newId).not.toBeNull();
      expect(state.edges).toHaveLength(1);
      expect(state.edges[0]).toMatchObject({
        data: { edgeType: "data-flow" },
        id: newId,
        source: "a",
        sourceHandle: "source-right",
        target: "b",
        targetHandle: "target-left",
        type: "cf-edge",
      });
      expect(state.dirty).toBe(true);
      expect(state.undoStack).toHaveLength(1);
      expect(state.redoStack).toHaveLength(0);
      expect(state.selectedEdgeId).toBe(newId);
      expect(state.propertiesOpen).toBe(true);
    });

    it("allows a second edge between the same nodes with a different edge type", () => {
      useDiagramStore.getState().connectNodes("a", "b", "data-flow");
      const secondId = useDiagramStore
        .getState()
        .connectNodes("a", "b", "trigger");

      expect(secondId).not.toBeNull();
      expect(useDiagramStore.getState().edges).toHaveLength(2);
    });

    it("rejects connecting a node to itself and mutates nothing", () => {
      const result = useDiagramStore
        .getState()
        .connectNodes("a", "a", "data-flow");

      expect(result).toBeNull();
      const state = useDiagramStore.getState();
      expect(state.edges).toHaveLength(0);
      expect(state.undoStack).toHaveLength(0);
      expect(state.dirty).toBe(false);
    });

    it("rejects an exact source/target/edge-type duplicate and mutates nothing", () => {
      useDiagramStore.getState().connectNodes("a", "b", "data-flow");
      useDiagramStore.setState({ dirty: false });

      const result = useDiagramStore
        .getState()
        .connectNodes("a", "b", "data-flow");

      expect(result).toBeNull();
      const state = useDiagramStore.getState();
      expect(state.edges).toHaveLength(1);
      expect(state.dirty).toBe(false);
    });

    it("returns null and mutates nothing when either node id does not exist", () => {
      const result = useDiagramStore
        .getState()
        .connectNodes("a", "does-not-exist", "data-flow");

      expect(result).toBeNull();
      expect(useDiagramStore.getState().edges).toHaveLength(0);
    });
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

  it("opens the properties panel when a node is selected (Bug 4)", () => {
    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
    useDiagramStore.getState().setSelectedNode("a");
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  it("opens the properties panel when an edge is selected (Bug 4)", () => {
    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
    useDiagramStore.getState().setSelectedEdge("e1");
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  it("leaves the properties panel open when deselecting rather than auto-closing it", () => {
    useDiagramStore.getState().setSelectedNode("a");
    useDiagramStore.getState().setSelectedNode(null);
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  it("does not reopen the properties panel when deselecting from a closed state", () => {
    useDiagramStore.setState({ propertiesOpen: false });
    useDiagramStore.getState().setSelectedEdge(null);
    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });

  it("toggles the palette and properties panel visibility", () => {
    expect(useDiagramStore.getState().paletteOpen).toBe(true);
    useDiagramStore.getState().togglePalette();
    expect(useDiagramStore.getState().paletteOpen).toBe(false);
    useDiagramStore.getState().togglePalette();
    expect(useDiagramStore.getState().paletteOpen).toBe(true);

    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
    useDiagramStore.getState().toggleProperties();
    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
    useDiagramStore.getState().toggleProperties();
    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });

  it("toggles the minimap visibility without marking the graph dirty", () => {
    expect(useDiagramStore.getState().minimapOpen).toBe(true);
    useDiagramStore.getState().toggleMinimap();
    expect(useDiagramStore.getState().minimapOpen).toBe(false);
    expect(useDiagramStore.getState().dirty).toBe(false);
    useDiagramStore.getState().toggleMinimap();
    expect(useDiagramStore.getState().minimapOpen).toBe(true);
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

    useDiagramStore.getState().markSaved("2026-01-01T00:00:00.000Z");
    let state = useDiagramStore.getState();
    expect(state.saving).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.lastSavedAt).not.toBeNull();
    expect(state.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    useDiagramStore.getState().markSaveError("Network error");
    state = useDiagramStore.getState();
    expect(state.saving).toBe(false);
    expect(state.saveError).toBe("Network error");
  });

  it("toggles print mode", () => {
    expect(useDiagramStore.getState().printMode).toBe(false);
    useDiagramStore.getState().setPrintMode(true);
    expect(useDiagramStore.getState().printMode).toBe(true);
    useDiagramStore.getState().setPrintMode(false);
    expect(useDiagramStore.getState().printMode).toBe(false);
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

  describe("applyRemoteGraphSnapshot", () => {
    it("replaces the graph and clears dirty/history", () => {
      useDiagramStore.getState().addNode(makeNode("a"));

      useDiagramStore.getState().applyRemoteGraphSnapshot(
        JSON.stringify({
          nodes: [makeNode("b")],
          edges: [],
          viewport: { x: 1, y: 2, zoom: 1 },
        }),
      );

      const state = useDiagramStore.getState();
      expect(state.nodes.map((n) => n.id)).toEqual(["b"]);
      expect(state.viewport).toEqual({ x: 1, y: 2, zoom: 1 });
      expect(state.dirty).toBe(false);
      expect(state.undoStack).toHaveLength(0);
      expect(state.redoStack).toHaveLength(0);
    });

    it("defaults missing nodes, edges, and viewport in the snapshot", () => {
      useDiagramStore.getState().applyRemoteGraphSnapshot("{}");

      const state = useDiagramStore.getState();
      expect(state.nodes).toEqual([]);
      expect(state.edges).toEqual([]);
      expect(state.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    });

    it("ignores a snapshot whose graphData fails to parse, mutating nothing", () => {
      useDiagramStore.getState().addNode(makeNode("a"));

      useDiagramStore.getState().applyRemoteGraphSnapshot("not json");

      const state = useDiagramStore.getState();
      expect(state.nodes.map((n) => n.id)).toEqual(["a"]);
    });
  });

  describe("applyRemoteOperation", () => {
    it("applies an add_node operation from another identity", () => {
      useDiagramStore.getState().applyRemoteOperation({
        input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      });

      const state = useDiagramStore.getState();
      expect(state.nodes).toHaveLength(1);
      expect(state.nodes[0]?.data.label).toBe("API");
    });

    it("applies an update_node operation from another identity", () => {
      useDiagramStore.getState().addNode(makeNode("a"));

      useDiagramStore.getState().applyRemoteOperation({
        kind: "update_node",
        nodeId: "a",
        patch: { label: "Renamed remotely" },
      });

      expect(useDiagramStore.getState().nodes[0]?.data.label).toBe(
        "Renamed remotely",
      );
    });

    it("applies a remove_node operation, cascading edge removal", () => {
      useDiagramStore.setState({
        edges: [
          {
            data: { edgeType: "data-flow" },
            id: "e1",
            source: "a",
            target: "b",
          } as Edge<CFEdgeData>,
        ],
        nodes: [makeNode("a"), makeNode("b")],
      });

      useDiagramStore
        .getState()
        .applyRemoteOperation({ kind: "remove_node", nodeId: "a" });

      const state = useDiagramStore.getState();
      expect(state.nodes.map((n) => n.id)).toEqual(["b"]);
      expect(state.edges).toHaveLength(0);
    });

    it("does not touch the viewport", () => {
      useDiagramStore.setState({ viewport: { x: 5, y: 5, zoom: 2 } });

      useDiagramStore.getState().applyRemoteOperation({
        input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      });

      expect(useDiagramStore.getState().viewport).toEqual({
        x: 5,
        y: 5,
        zoom: 2,
      });
    });

    it("silently ignores a stale-target operation, mutating nothing", () => {
      useDiagramStore.getState().addNode(makeNode("a"));

      useDiagramStore.getState().applyRemoteOperation({
        kind: "update_node",
        nodeId: "does-not-exist",
        patch: { label: "x" },
      });

      expect(useDiagramStore.getState().nodes.map((n) => n.id)).toEqual(["a"]);
    });
  });

  describe("showLiveUpdateNotice / dismissLiveUpdateNotice", () => {
    it("shows the notice with the acting identity and origin", () => {
      useDiagramStore
        .getState()
        .showLiveUpdateNotice("bob@example.com", "human");

      expect(useDiagramStore.getState().liveUpdateNotice).toEqual({
        actorEmail: "bob@example.com",
        origin: "human",
      });
    });

    it("clears the live update notice", () => {
      useDiagramStore.setState({
        liveUpdateNotice: { actorEmail: "bob@example.com", origin: "human" },
      });
      useDiagramStore.getState().dismissLiveUpdateNotice();
      expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
    });
  });

  describe("enqueueOperation / drainPendingOperations", () => {
    it("coalesces repeated update_node operations for the same node id, keeping only the last", () => {
      useDiagramStore.getState().enqueueOperation({
        kind: "update_node",
        nodeId: "a",
        patch: { position: { x: 1, y: 1 } },
      });
      useDiagramStore.getState().enqueueOperation({
        kind: "update_node",
        nodeId: "a",
        patch: { position: { x: 2, y: 2 } },
      });

      const ops = useDiagramStore.getState().drainPendingOperations();
      expect(ops).toEqual([
        {
          kind: "update_node",
          nodeId: "a",
          patch: { position: { x: 2, y: 2 } },
        },
      ]);
    });

    it("keeps operations for different target ids separate", () => {
      useDiagramStore
        .getState()
        .enqueueOperation({ kind: "remove_node", nodeId: "a" });
      useDiagramStore
        .getState()
        .enqueueOperation({ kind: "remove_node", nodeId: "b" });

      const ops = useDiagramStore.getState().drainPendingOperations();
      expect(ops).toHaveLength(2);
    });

    it("does not coalesce two add_node operations with each other", () => {
      useDiagramStore.getState().enqueueOperation({
        input: { label: "A", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      });
      useDiagramStore.getState().enqueueOperation({
        input: { label: "B", position: { x: 0, y: 0 }, typeId: "worker" },
        kind: "add_node",
      });

      expect(useDiagramStore.getState().drainPendingOperations()).toHaveLength(
        2,
      );
    });

    it("empties the queue once drained", () => {
      useDiagramStore
        .getState()
        .enqueueOperation({ kind: "remove_node", nodeId: "a" });
      useDiagramStore.getState().drainPendingOperations();

      expect(useDiagramStore.getState().drainPendingOperations()).toEqual([]);
    });
  });

  describe("mutation actions enqueue their equivalent operation", () => {
    it("addNode enqueues add_node", () => {
      useDiagramStore.getState().addNode(makeNode("a", "d1"));

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toMatchObject({ kind: "add_node", input: { typeId: "d1" } });
    });

    it("updateNodeData enqueues update_node with only label/description", () => {
      useDiagramStore.getState().addNode(makeNode("a"));
      useDiagramStore.getState().drainPendingOperations();

      useDiagramStore.getState().updateNodeData("a", {
        label: "Renamed",
        style: { accentColor: "#fff" },
      });

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toEqual({
        kind: "update_node",
        nodeId: "a",
        patch: { label: "Renamed" },
      });
    });

    it("updateNodeData enqueues nothing when the patch carries no synced field", () => {
      useDiagramStore.getState().addNode(makeNode("a"));
      useDiagramStore.getState().drainPendingOperations();

      useDiagramStore
        .getState()
        .updateNodeData("a", { style: { accentColor: "#fff" } });

      expect(useDiagramStore.getState().drainPendingOperations()).toEqual([]);
    });

    it("updateEdgeData enqueues update_edge", () => {
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

      useDiagramStore.getState().updateEdgeData("e1", { edgeType: "trigger" });

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toEqual({
        edgeId: "e1",
        kind: "update_edge",
        patch: { edgeType: "trigger" },
      });
    });

    it("removeSelected enqueues one remove_node/remove_edge operation per removed id", () => {
      useDiagramStore.setState({
        edges: [
          {
            data: { edgeType: "data-flow" },
            id: "e1",
            selected: true,
            source: "a",
            target: "b",
          } as Edge<CFEdgeData>,
        ],
        nodes: [
          { ...makeNode("a"), selected: true },
          { ...makeNode("b"), selected: false },
        ],
      });

      useDiagramStore.getState().removeSelected();

      const ops = useDiagramStore.getState().drainPendingOperations();
      expect(ops).toEqual(
        expect.arrayContaining([
          { kind: "remove_node", nodeId: "a" },
          { edgeId: "e1", kind: "remove_edge" },
        ]),
      );
      expect(ops).toHaveLength(2);
    });

    it("onConnect enqueues add_edge", () => {
      useDiagramStore.getState().onConnect({
        source: "a",
        sourceHandle: null,
        target: "b",
        targetHandle: null,
      });

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toEqual({
        input: { edgeType: "data-flow", source: "a", target: "b" },
        kind: "add_edge",
      });
    });

    it("connectNodes enqueues add_edge", () => {
      useDiagramStore.setState({
        nodes: [
          { ...makeNode("a"), position: { x: 0, y: 0 } },
          { ...makeNode("b"), position: { x: 300, y: 0 } },
        ],
      });

      useDiagramStore.getState().connectNodes("a", "b", "trigger");

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toEqual({
        input: { edgeType: "trigger", source: "a", target: "b" },
        kind: "add_edge",
      });
    });

    it("onNodesChange enqueues update_node for a position change", () => {
      useDiagramStore.getState().addNode(makeNode("a"));
      useDiagramStore.getState().drainPendingOperations();

      useDiagramStore
        .getState()
        .onNodesChange([
          { id: "a", position: { x: 5, y: 5 }, type: "position" },
        ]);

      const [op] = useDiagramStore.getState().drainPendingOperations();
      expect(op).toEqual({
        kind: "update_node",
        nodeId: "a",
        patch: { position: { x: 5, y: 5 } },
      });
    });
  });
});
