import { describe, expect, it } from "vitest";
import {
  addEdge,
  addNode,
  applyGraphOperation,
  autoLayout,
  removeEdge,
  removeNode,
  updateEdge,
  updateNode,
} from "./graph-mutations";
import type { GraphData } from "./worker/diagrams/types";

/** An empty canonical graph, the starting point for most tests below. */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** A graph with two nodes and no edges, for node-mutation tests. */
function twoNodeGraph(): GraphData {
  return {
    edges: [],
    nodes: [
      {
        data: { description: "", label: "API", typeId: "worker" },
        id: "a",
        position: { x: 0, y: 0 },
        type: "cf-node",
      },
      {
        data: { description: "", label: "Database", typeId: "d1" },
        id: "b",
        position: { x: 100, y: 100 },
        type: "cf-node",
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe("addNode", () => {
  it("appends a node with a generated id, the cf-node type, and the given fields", () => {
    const result = addNode(emptyGraph(), {
      description: "The API gateway",
      label: "API",
      position: { x: 10, y: 20 },
      typeId: "worker",
    });

    expect(result.nodes).toHaveLength(1);
    const [node] = result.nodes as {
      id: string;
      type: string;
      position: { x: number; y: number };
      data: Record<string, unknown>;
    }[];
    expect(node.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(node.type).toBe("cf-node");
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.data).toEqual({
      description: "The API gateway",
      label: "API",
      typeId: "worker",
    });
  });

  it("defaults an omitted description to an empty string", () => {
    const result = addNode(emptyGraph(), {
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    const [node] = result.nodes as { data: { description: string } }[];
    expect(node.data.description).toBe("");
  });

  it("never mutates the input graph", () => {
    const original = emptyGraph();
    addNode(original, {
      label: "API",
      position: { x: 0, y: 0 },
      typeId: "worker",
    });
    expect(original.nodes).toHaveLength(0);
  });
});

describe("updateNode", () => {
  it("merges label and description into the matching node's data", () => {
    const result = updateNode(twoNodeGraph(), "a", {
      description: "Updated",
      label: "New Label",
    });
    const node = result.nodes.find((n) => (n as { id: string }).id === "a") as {
      data: Record<string, unknown>;
    };
    expect(node.data).toMatchObject({
      description: "Updated",
      label: "New Label",
      typeId: "worker",
    });
  });

  it("replaces position when given, leaving data untouched", () => {
    const result = updateNode(twoNodeGraph(), "a", {
      position: { x: 999, y: 999 },
    });
    const node = result.nodes.find((n) => (n as { id: string }).id === "a") as {
      position: { x: number; y: number };
      data: Record<string, unknown>;
    };
    expect(node.position).toEqual({ x: 999, y: 999 });
    expect(node.data).toMatchObject({ label: "API" });
  });

  it("leaves an unpatched node in place", () => {
    const result = updateNode(twoNodeGraph(), "a", { label: "New Label" });
    const other = result.nodes.find((n) => (n as { id: string }).id === "b");
    expect(other).toMatchObject({ data: { label: "Database" } });
  });

  it("throws notFound for a node id that does not exist", () => {
    expect(() =>
      updateNode(twoNodeGraph(), "does-not-exist", { label: "x" }),
    ).toThrow();
  });
});

describe("removeNode", () => {
  it("removes the node and cascades removal of every edge touching it", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };

    const result = removeNode(graph, "a");

    expect(result.nodes.map((n) => (n as { id: string }).id)).toEqual(["b"]);
    expect(result.edges).toHaveLength(0);
  });

  it("leaves edges untouched when they do not reference the removed node", () => {
    const graph: GraphData = {
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "b",
          target: "b",
        },
      ],
      nodes: twoNodeGraph().nodes,
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const result = removeNode(graph, "a");
    expect(result.edges).toHaveLength(1);
  });

  it("throws notFound for a node id that does not exist", () => {
    expect(() => removeNode(twoNodeGraph(), "does-not-exist")).toThrow();
  });
});

describe("addEdge", () => {
  it("appends an edge with a generated id, the cf-edge type, and the given fields", () => {
    const result = addEdge(twoNodeGraph(), {
      edgeType: "service-binding",
      label: "binds to",
      protocol: "binding",
      source: "a",
      target: "b",
    });

    expect(result.edges).toHaveLength(1);
    const [edge] = result.edges as {
      id: string;
      type: string;
      source: string;
      target: string;
      data: Record<string, unknown>;
    }[];
    expect(edge.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(edge.type).toBe("cf-edge");
    expect(edge.source).toBe("a");
    expect(edge.target).toBe("b");
    expect(edge.data).toEqual({
      edgeType: "service-binding",
      label: "binds to",
      protocol: "binding",
    });
  });

  it("includes a description when given", () => {
    const result = addEdge(twoNodeGraph(), {
      description: "Carries API traffic to the database",
      edgeType: "data-flow",
      source: "a",
      target: "b",
    });
    const [edge] = result.edges as { data: Record<string, unknown> }[];
    expect(edge.data.description).toBe("Carries API traffic to the database");
  });

  it("omits label/description/protocol entirely when not given", () => {
    const result = addEdge(twoNodeGraph(), {
      edgeType: "data-flow",
      source: "a",
      target: "b",
    });
    const [edge] = result.edges as { data: Record<string, unknown> }[];
    expect(edge.data).toEqual({ edgeType: "data-flow" });
  });

  it("throws notFound when the source node does not exist", () => {
    expect(() =>
      addEdge(twoNodeGraph(), {
        edgeType: "data-flow",
        source: "does-not-exist",
        target: "b",
      }),
    ).toThrow();
  });

  it("throws notFound when the target node does not exist", () => {
    expect(() =>
      addEdge(twoNodeGraph(), {
        edgeType: "data-flow",
        source: "a",
        target: "does-not-exist",
      }),
    ).toThrow();
  });
});

describe("updateEdge", () => {
  function graphWithEdge(): GraphData {
    return {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
  }

  it("merges fields into the matching edge's data", () => {
    const result = updateEdge(graphWithEdge(), "e1", {
      edgeType: "trigger",
      label: "fires",
    });
    const [edge] = result.edges as { data: Record<string, unknown> }[];
    expect(edge.data).toEqual({ edgeType: "trigger", label: "fires" });
  });

  it("merges a description and protocol into the matching edge's data", () => {
    const result = updateEdge(graphWithEdge(), "e1", {
      description: "Reads and writes application data",
      protocol: "binding",
    });
    const [edge] = result.edges as { data: Record<string, unknown> }[];
    expect(edge.data).toEqual({
      description: "Reads and writes application data",
      edgeType: "data-flow",
      protocol: "binding",
    });
  });

  it("throws notFound for an edge id that does not exist", () => {
    expect(() =>
      updateEdge(graphWithEdge(), "does-not-exist", { label: "x" }),
    ).toThrow();
  });
});

describe("removeEdge", () => {
  it("removes the matching edge, leaving nodes untouched", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    const result = removeEdge(graph, "e1");
    expect(result.edges).toHaveLength(0);
    expect(result.nodes).toHaveLength(2);
  });

  it("throws notFound for an edge id that does not exist", () => {
    expect(() => removeEdge(twoNodeGraph(), "does-not-exist")).toThrow();
  });
});

describe("autoLayout", () => {
  it("returns an empty graph unchanged", () => {
    const result = autoLayout(emptyGraph());
    expect(result.nodes).toEqual([]);
  });

  it("places every root node (no incoming edge) on row 0, spread across columns", () => {
    const result = autoLayout(twoNodeGraph());
    const positions = Object.fromEntries(
      result.nodes.map((n) => [
        (n as { id: string }).id,
        (n as { position: { x: number; y: number } }).position,
      ]),
    );
    expect(positions.a.y).toBe(0);
    expect(positions.b.y).toBe(0);
    expect(positions.a.x).not.toBe(positions.b.x);
  });

  it("places a node one edge away from a root on the next row", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    const result = autoLayout(graph);
    const positions = Object.fromEntries(
      result.nodes.map((n) => [
        (n as { id: string }).id,
        (n as { position: { x: number; y: number } }).position,
      ]),
    );
    expect(positions.a.y).toBe(0);
    expect(positions.b.y).toBeGreaterThan(positions.a.y);
  });

  it("visits a node reachable from two different roots only once", () => {
    const graph: GraphData = {
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "c" },
        { data: { edgeType: "data-flow" }, id: "e2", source: "b", target: "c" },
      ],
      nodes: [
        ...twoNodeGraph().nodes,
        {
          data: { description: "", label: "Queue", typeId: "queues" },
          id: "c",
          position: { x: 200, y: 200 },
          type: "cf-node",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const result = autoLayout(graph);
    const positions = Object.fromEntries(
      result.nodes.map((n) => [
        (n as { id: string }).id,
        (n as { position: { x: number; y: number } }).position,
      ]),
    );
    expect(positions.a.y).toBe(0);
    expect(positions.b.y).toBe(0);
    expect(positions.c.y).toBeGreaterThan(0);
  });

  it("never leaves a node unpositioned when every node is part of a cycle", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
        { data: { edgeType: "data-flow" }, id: "e2", source: "b", target: "a" },
      ],
    };
    const result = autoLayout(graph);
    for (const node of result.nodes) {
      const position = (node as { position?: { x: number; y: number } })
        .position;
      expect(position).toBeDefined();
      expect(Number.isFinite(position?.x)).toBe(true);
      expect(Number.isFinite(position?.y)).toBe(true);
    }
  });

  it("skips an edge missing a source or target when computing rows", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [{ data: { edgeType: "data-flow" }, id: "e1" }],
    };
    const result = autoLayout(graph);
    const positions = Object.fromEntries(
      result.nodes.map((n) => [
        (n as { id: string }).id,
        (n as { position: { x: number; y: number } }).position,
      ]),
    );
    // With the malformed edge ignored entirely, both nodes are roots on row 0.
    expect(positions.a.y).toBe(0);
    expect(positions.b.y).toBe(0);
  });

  it("skips a dangling edge referencing a node id that no longer exists", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "a",
          target: "does-not-exist",
        },
      ],
    };
    const result = autoLayout(graph);
    const positions = Object.fromEntries(
      result.nodes.map((n) => [
        (n as { id: string }).id,
        (n as { position: { x: number; y: number } }).position,
      ]),
    );
    expect(positions.a.y).toBe(0);
    expect(positions.b.y).toBe(0);
  });

  it("is deterministic: running it twice on the same graph yields identical positions", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    expect(autoLayout(graph)).toEqual(autoLayout(graph));
  });

  it("leaves edges and viewport unchanged", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
      viewport: { x: 5, y: 5, zoom: 2 },
    };
    const result = autoLayout(graph);
    expect(result.edges).toEqual(graph.edges);
    expect(result.viewport).toEqual({ x: 5, y: 5, zoom: 2 });
  });
});

describe("applyGraphOperation", () => {
  it("dispatches add_node to addNode", () => {
    const result = applyGraphOperation(emptyGraph(), {
      input: { label: "API", position: { x: 0, y: 0 }, typeId: "worker" },
      kind: "add_node",
    });
    expect(result.nodes).toHaveLength(1);
    expect((result.nodes[0] as { data: { label: string } }).data.label).toBe(
      "API",
    );
  });

  it("dispatches update_node to updateNode", () => {
    const result = applyGraphOperation(twoNodeGraph(), {
      kind: "update_node",
      nodeId: "a",
      patch: { label: "New Label" },
    });
    const node = result.nodes.find((n) => (n as { id: string }).id === "a");
    expect(node).toMatchObject({ data: { label: "New Label" } });
  });

  it("dispatches remove_node to removeNode, cascading edge removal", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    const result = applyGraphOperation(graph, {
      kind: "remove_node",
      nodeId: "a",
    });
    expect(result.nodes.map((n) => (n as { id: string }).id)).toEqual(["b"]);
    expect(result.edges).toHaveLength(0);
  });

  it("dispatches add_edge to addEdge", () => {
    const result = applyGraphOperation(twoNodeGraph(), {
      input: { edgeType: "data-flow", source: "a", target: "b" },
      kind: "add_edge",
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("dispatches update_edge to updateEdge", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    const result = applyGraphOperation(graph, {
      edgeId: "e1",
      kind: "update_edge",
      patch: { edgeType: "trigger" },
    });
    expect((result.edges[0] as { data: { edgeType: string } }).data).toEqual({
      edgeType: "trigger",
    });
  });

  it("dispatches remove_edge to removeEdge", () => {
    const graph: GraphData = {
      ...twoNodeGraph(),
      edges: [
        { data: { edgeType: "data-flow" }, id: "e1", source: "a", target: "b" },
      ],
    };
    const result = applyGraphOperation(graph, {
      edgeId: "e1",
      kind: "remove_edge",
    });
    expect(result.edges).toHaveLength(0);
  });

  it("propagates notFound() for a stale nodeId", () => {
    expect(() =>
      applyGraphOperation(twoNodeGraph(), {
        kind: "update_node",
        nodeId: "does-not-exist",
        patch: { label: "x" },
      }),
    ).toThrow();
  });

  it("propagates notFound() for a stale edgeId", () => {
    expect(() =>
      applyGraphOperation(twoNodeGraph(), {
        edgeId: "does-not-exist",
        kind: "remove_edge",
      }),
    ).toThrow();
  });
});
