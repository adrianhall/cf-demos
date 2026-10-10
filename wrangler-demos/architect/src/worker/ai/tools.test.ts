import { describe, expect, it } from "vitest";
import { EDGE_TYPES, NODE_TYPES } from "../../catalog";
import type { GraphData } from "../diagrams/types";
import { dispatchToolCall, TOOL_DEFINITIONS } from "./tools";

/** An empty canonical graph. */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** A graph with two nodes ("a", "b") and no edges. */
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

/** A graph with two nodes and one edge ("e1", "a" -> "b"). */
function graphWithEdge(): GraphData {
  const graph = twoNodeGraph();
  return {
    ...graph,
    edges: [
      {
        data: { edgeType: "data-flow", label: "Query" },
        id: "e1",
        source: "a",
        target: "b",
        type: "cf-edge",
      },
    ],
  };
}

const REAL_NODE_TYPE_ID = NODE_TYPES[0]?.typeId ?? "worker";
const REAL_EDGE_TYPE = EDGE_TYPES[0]?.edgeType ?? "data-flow";

describe("TOOL_DEFINITIONS", () => {
  it("has exactly the 8 tool catalog entries, each with a JSON-schema parameters object", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "add_edge",
        "add_node",
        "remove_edge",
        "remove_node",
        "rename_diagram",
        "search_cloudflare_documentation",
        "update_edge",
        "update_node",
      ].sort(),
    );
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  it("gives every field a description (per this repo's tool-design convention)", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const properties = tool.parameters.properties as
        | Record<string, { description?: string }>
        | undefined;
      if (properties === undefined) continue;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("dispatchToolCall: add_node", () => {
  it("produces the exact expected add_node GraphOperation with a supplied position", () => {
    const result = dispatchToolCall(
      "add_node",
      {
        description: "The API gateway",
        label: "API",
        position: { x: 10, y: 20 },
        typeId: REAL_NODE_TYPE_ID,
      },
      emptyGraph(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: {
        input: {
          description: "The API gateway",
          label: "API",
          position: { x: 10, y: 20 },
          typeId: REAL_NODE_TYPE_ID,
        },
        kind: "add_node",
      },
    });
  });

  it("fills in a default position via nextGridPosition when omitted", () => {
    const result = dispatchToolCall(
      "add_node",
      { label: "API", typeId: REAL_NODE_TYPE_ID },
      emptyGraph(),
    );
    expect(result.kind).toBe("graph_operation");
    if (
      result.kind !== "graph_operation" ||
      result.operation.kind !== "add_node"
    ) {
      throw new Error("expected an add_node graph_operation result");
    }
    expect(result.operation.input.position).toEqual({ x: 0, y: 0 });
  });

  it("returns a tool_error (not a throw) for a hallucinated typeId, listing valid values", () => {
    const result = dispatchToolCall(
      "add_node",
      { label: "API", typeId: "not-a-real-type" },
      emptyGraph(),
    );
    expect(result.kind).toBe("tool_error");
    if (result.kind !== "tool_error") throw new Error("expected tool_error");
    expect(result.message).toContain("not-a-real-type");
    expect(result.message).toContain(REAL_NODE_TYPE_ID);
  });

  it("returns a tool_error for missing required fields", () => {
    const result = dispatchToolCall(
      "add_node",
      { typeId: REAL_NODE_TYPE_ID },
      emptyGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });

  it("returns a tool_error for malformed (wrong-type) arguments", () => {
    const result = dispatchToolCall(
      "add_node",
      { label: 42, typeId: REAL_NODE_TYPE_ID },
      emptyGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: update_node", () => {
  it("produces the exact expected update_node GraphOperation", () => {
    const result = dispatchToolCall(
      "update_node",
      { description: "Updated", label: "New Label", nodeId: "a" },
      twoNodeGraph(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: {
        kind: "update_node",
        nodeId: "a",
        patch: {
          description: "Updated",
          label: "New Label",
          position: undefined,
        },
      },
    });
  });

  it("returns a tool_error for missing nodeId", () => {
    const result = dispatchToolCall(
      "update_node",
      { label: "New" },
      twoNodeGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: remove_node", () => {
  it("produces the exact expected remove_node GraphOperation", () => {
    const result = dispatchToolCall(
      "remove_node",
      { nodeId: "a" },
      twoNodeGraph(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: { kind: "remove_node", nodeId: "a" },
    });
  });

  it("returns a tool_error for a missing nodeId argument", () => {
    const result = dispatchToolCall("remove_node", {}, twoNodeGraph());
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: add_edge", () => {
  it("produces the exact expected add_edge GraphOperation", () => {
    const result = dispatchToolCall(
      "add_edge",
      { edgeType: REAL_EDGE_TYPE, source: "a", target: "b" },
      twoNodeGraph(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: {
        input: {
          description: undefined,
          edgeType: REAL_EDGE_TYPE,
          label: undefined,
          protocol: undefined,
          source: "a",
          target: "b",
        },
        kind: "add_edge",
      },
    });
  });

  it("returns a tool_error (not a throw) for a hallucinated edgeType, listing valid values", () => {
    const result = dispatchToolCall(
      "add_edge",
      { edgeType: "not-a-real-edge-type", source: "a", target: "b" },
      twoNodeGraph(),
    );
    expect(result.kind).toBe("tool_error");
    if (result.kind !== "tool_error") throw new Error("expected tool_error");
    expect(result.message).toContain("not-a-real-edge-type");
    expect(result.message).toContain(REAL_EDGE_TYPE);
  });

  it("returns a tool_error for missing required fields", () => {
    const result = dispatchToolCall(
      "add_edge",
      { source: "a" },
      twoNodeGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: update_edge", () => {
  it("produces the exact expected update_edge GraphOperation", () => {
    const result = dispatchToolCall(
      "update_edge",
      { edgeId: "e1", label: "New label" },
      graphWithEdge(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: {
        edgeId: "e1",
        kind: "update_edge",
        patch: {
          description: undefined,
          edgeType: undefined,
          label: "New label",
          protocol: undefined,
        },
      },
    });
  });

  it("returns a tool_error for a hallucinated edgeType", () => {
    const result = dispatchToolCall(
      "update_edge",
      { edgeId: "e1", edgeType: "not-a-real-edge-type" },
      graphWithEdge(),
    );
    expect(result.kind).toBe("tool_error");
    if (result.kind !== "tool_error") throw new Error("expected tool_error");
    expect(result.message).toContain("not-a-real-edge-type");
  });

  it("returns a tool_error for a missing edgeId", () => {
    const result = dispatchToolCall(
      "update_edge",
      { label: "New" },
      graphWithEdge(),
    );
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: remove_edge", () => {
  it("produces the exact expected remove_edge GraphOperation", () => {
    const result = dispatchToolCall(
      "remove_edge",
      { edgeId: "e1" },
      graphWithEdge(),
    );
    expect(result).toEqual({
      kind: "graph_operation",
      operation: { edgeId: "e1", kind: "remove_edge" },
    });
  });

  it("returns a tool_error for a missing edgeId argument", () => {
    const result = dispatchToolCall("remove_edge", {}, graphWithEdge());
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: rename_diagram", () => {
  it("produces the exact expected rename_diagram result", () => {
    const result = dispatchToolCall(
      "rename_diagram",
      {
        description: "A real-time strategy game backend",
        title: "Game Backend",
      },
      emptyGraph(),
    );
    expect(result).toEqual({
      description: "A real-time strategy game backend",
      kind: "rename_diagram",
      title: "Game Backend",
    });
  });

  it("accepts title only", () => {
    const result = dispatchToolCall(
      "rename_diagram",
      { title: "Game Backend" },
      emptyGraph(),
    );
    expect(result).toEqual({
      description: undefined,
      kind: "rename_diagram",
      title: "Game Backend",
    });
  });

  it("returns a tool_error when neither title nor description is provided", () => {
    const result = dispatchToolCall("rename_diagram", {}, emptyGraph());
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: search_cloudflare_documentation", () => {
  it("produces the exact expected result shape", () => {
    const result = dispatchToolCall(
      "search_cloudflare_documentation",
      { query: "Durable Objects WebSocket hibernation" },
      emptyGraph(),
    );
    expect(result).toEqual({
      kind: "search_cloudflare_documentation",
      query: "Durable Objects WebSocket hibernation",
    });
  });

  it("returns a tool_error for a missing query", () => {
    const result = dispatchToolCall(
      "search_cloudflare_documentation",
      {},
      emptyGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });

  it("returns a tool_error for an empty query string", () => {
    const result = dispatchToolCall(
      "search_cloudflare_documentation",
      { query: "" },
      emptyGraph(),
    );
    expect(result.kind).toBe("tool_error");
  });
});

describe("dispatchToolCall: unknown tool", () => {
  it("returns a tool_error, not a throw, for an unrecognized tool name", () => {
    const result = dispatchToolCall("delete_everything", {}, emptyGraph());
    expect(result.kind).toBe("tool_error");
    if (result.kind !== "tool_error") throw new Error("expected tool_error");
    expect(result.message).toContain("delete_everything");
  });
});
