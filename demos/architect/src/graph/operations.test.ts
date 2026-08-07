import { describe, expect, it } from "vitest";
import { applyGraphOperation, GraphOperationError } from "./operations";
import type { GraphDocument } from "./types";

const document: GraphDocument = {
  version: 1,
  nodes: [
    {
      id: "workers-1",
      type: "product",
      position: { x: 0, y: 0 },
      data: { productId: "workers", label: "Workers", description: "" },
    },
    {
      id: "browser-1",
      type: "actor",
      position: { x: 100, y: 0 },
      data: { kind: "external-actor", label: "Browser" },
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "browser-1",
      target: "workers-1",
      type: "request",
      data: { relationship: "request", label: "HTTPS" },
    },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe("applyGraphOperation", () => {
  it("appends a new node for add_node", () => {
    const next = applyGraphOperation(document, {
      kind: "add_node",
      payload: {
        node: {
          id: "d1-1",
          type: "product",
          position: { x: 200, y: 200 },
          data: { productId: "d1", label: "D1", description: "" },
        },
      },
    });
    expect(next.nodes).toHaveLength(3);
    expect(document.nodes).toHaveLength(2); // input document is never mutated
  });

  it("rejects add_node when the id already exists", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "add_node",
        payload: { node: document.nodes[0] },
      }),
    ).toThrow(GraphOperationError);
  });

  it("replaces node data for update_node without touching position", () => {
    const next = applyGraphOperation(document, {
      kind: "update_node",
      payload: {
        nodeId: "workers-1",
        data: { productId: "workers", label: "Renamed", description: "d" },
      },
    });
    const updated = next.nodes.find((node) => node.id === "workers-1");
    expect(updated?.data).toEqual({
      productId: "workers",
      label: "Renamed",
      description: "d",
    });
    expect(updated?.position).toEqual({ x: 0, y: 0 });
  });

  it("rejects update_node for a missing node", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "update_node",
        payload: {
          nodeId: "missing",
          data: { kind: "external-actor", label: "x" },
        },
      }),
    ).toThrow(GraphOperationError);
  });

  it("moves a node's position for move_node", () => {
    const next = applyGraphOperation(document, {
      kind: "move_node",
      payload: { nodeId: "browser-1", position: { x: 42, y: 42 } },
    });
    const moved = next.nodes.find((node) => node.id === "browser-1");
    expect(moved?.position).toEqual({ x: 42, y: 42 });
  });

  it("rejects move_node for a missing node", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "move_node",
        payload: { nodeId: "missing", position: { x: 0, y: 0 } },
      }),
    ).toThrow(GraphOperationError);
  });

  it("deletes a node and every edge touching it for delete_node", () => {
    const next = applyGraphOperation(document, {
      kind: "delete_node",
      payload: { nodeId: "workers-1" },
    });
    expect(next.nodes.map((node) => node.id)).toEqual(["browser-1"]);
    expect(next.edges).toHaveLength(0);
  });

  it("rejects delete_node for a missing node", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "delete_node",
        payload: { nodeId: "missing" },
      }),
    ).toThrow(GraphOperationError);
  });

  it("appends a new edge for add_edge", () => {
    const next = applyGraphOperation(document, {
      kind: "add_edge",
      payload: {
        edge: {
          id: "edge-2",
          source: "workers-1",
          target: "browser-1",
          type: "event",
          data: { relationship: "event", label: "notify" },
        },
      },
    });
    expect(next.edges).toHaveLength(2);
  });

  it("rejects add_edge when the id already exists", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "add_edge",
        payload: { edge: document.edges[0] },
      }),
    ).toThrow(GraphOperationError);
  });

  it("removes an edge for delete_edge", () => {
    const next = applyGraphOperation(document, {
      kind: "delete_edge",
      payload: { edgeId: "edge-1" },
    });
    expect(next.edges).toHaveLength(0);
  });

  it("rejects delete_edge for a missing edge", () => {
    expect(() =>
      applyGraphOperation(document, {
        kind: "delete_edge",
        payload: { edgeId: "missing" },
      }),
    ).toThrow(GraphOperationError);
  });

  it("replaces the whole document for replace_document", () => {
    const replacement: GraphDocument = {
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 3 },
    };
    const next = applyGraphOperation(document, {
      kind: "replace_document",
      payload: { document: replacement },
    });
    expect(next).toEqual(replacement);
    expect(next).not.toBe(replacement); // deep-cloned, not aliased
  });
});
