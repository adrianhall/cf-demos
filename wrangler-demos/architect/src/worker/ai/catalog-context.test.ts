import { describe, expect, it } from "vitest";
import { EDGE_TYPES, NODE_TYPES } from "../../catalog";
import type { GraphData } from "../diagrams/types";
import {
  buildCatalogPromptContext,
  buildGraphPromptContext,
  nextGridPosition,
} from "./catalog-context";

/** An empty canonical graph. */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/** A graph with `count` placeholder nodes -- only `nodes.length` matters to
 * {@link nextGridPosition}, so each node's own fields are irrelevant filler. */
function graphWithNodeCount(count: number): GraphData {
  return {
    edges: [],
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `node-${index}`,
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe("buildCatalogPromptContext", () => {
  it("reflects every current NODE_TYPES typeId and label", () => {
    const context = buildCatalogPromptContext();
    for (const node of NODE_TYPES) {
      expect(context).toContain(node.typeId);
      expect(context).toContain(node.label);
    }
  });

  it("reflects every current EDGE_TYPES edgeType and label", () => {
    const context = buildCatalogPromptContext();
    for (const edge of EDGE_TYPES) {
      expect(context).toContain(edge.edgeType);
      expect(context).toContain(edge.label);
    }
  });

  it("omits presentation/scaffold-only fields", () => {
    const context = buildCatalogPromptContext();
    // Icon kinds/names, handle ids, and wrangler binding identifiers never appear -- only
    // typeId/label/category/description (nodes) and edgeType/label/description (edges).
    expect(context).not.toContain("svg");
    expect(context).not.toContain("feather");
    expect(context).not.toContain("target-top");
    expect(context).not.toContain("wranglerBinding");
    expect(context).not.toContain("docLinks");
  });

  it("stays compact relative to the full catalog module's own source size", () => {
    const context = buildCatalogPromptContext();
    // A generous ceiling -- comfortably smaller than re-serializing every NodeTypeDef/EdgeTypeDef
    // field (icons, handles, doc links) would produce, without pinning to an exact byte count
    // that would need updating every time a description's wording changes.
    expect(context.length).toBeLessThan(8000);
  });

  it("is generated fresh, never cached, so two calls return equal content", () => {
    expect(buildCatalogPromptContext()).toBe(buildCatalogPromptContext());
  });
});

describe("buildGraphPromptContext", () => {
  it("says the canvas is empty when there is nothing on it", () => {
    expect(buildGraphPromptContext(emptyGraph())).toContain(
      "The canvas is empty.",
    );
  });

  it("lists every node's id, typeId and label, and every edge's id, endpoints and edgeType", () => {
    const context = buildGraphPromptContext({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "edge-1",
          source: "node-1",
          target: "node-2",
          type: "cf-edge",
        },
      ],
      nodes: [
        {
          data: { label: "Gateway", typeId: "worker-hono" },
          id: "node-1",
          type: "cf-node",
        },
        {
          data: { label: "World DB", typeId: "d1" },
          id: "node-2",
          type: "cf-node",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).toContain(
      "- id: node-1 | typeId: worker-hono | label: Gateway",
    );
    expect(context).toContain("- id: node-2 | typeId: d1 | label: World DB");
    expect(context).toContain(
      "- id: edge-1 | source: node-1 | target: node-2 | edgeType: data-flow",
    );
  });

  it("tells the model to use ids rather than labels", () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "node-1",
          type: "cf-node",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    // A model given no ids passes labels where ids belong and burns the whole round budget on
    // rejected calls (docs/DECISIONS.md #42), so the instruction is part of the contract.
    expect(context).toContain("never a label");
  });

  it("notes the absent side when a graph has nodes but no edges", () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [
        {
          data: { label: "A", typeId: "worker" },
          id: "node-1",
          type: "cf-node",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).toContain("(no edges)");
    expect(context).not.toContain("(no nodes)");
  });

  it("omits presentation-only fields that cannot change which id a tool call names", () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [
        {
          data: {
            description: "A long description the model does not need.",
            label: "A",
            typeId: "worker",
          },
          id: "node-1",
          position: { x: 1234, y: 5678 },
          type: "cf-node",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).not.toContain("1234");
    expect(context).not.toContain("does not need");
  });

  it("notes the absent side when a graph has edges but no nodes", () => {
    const context = buildGraphPromptContext({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "edge-1",
          source: "gone-1",
          target: "gone-2",
          type: "cf-edge",
        },
      ],
      nodes: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).toContain("(no nodes)");
    expect(context).not.toContain("(no edges)");
  });

  it("degrades to empty strings for a data field that is present but not a string", () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: { label: 42, typeId: null }, id: "node-1" }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).toContain("- id: node-1 | typeId:  | label: ");
  });

  it("degrades to empty strings rather than printing undefined for a malformed record", () => {
    const context = buildGraphPromptContext({
      edges: [],
      nodes: [{ data: null, id: 42 }],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(context).not.toContain("undefined");
    expect(context).toContain("- id:  | typeId:  | label: ");
  });
});

describe("nextGridPosition", () => {
  it("returns the origin for an empty graph", () => {
    expect(nextGridPosition(emptyGraph())).toEqual({ x: 0, y: 0 });
  });

  it("produces distinct positions for successive node counts", () => {
    const positions = Array.from({ length: 6 }, (_, count) =>
      nextGridPosition(graphWithNodeCount(count)),
    );
    const unique = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(unique.size).toBe(positions.length);
  });

  it("is deterministic for a fixed node count", () => {
    expect(nextGridPosition(graphWithNodeCount(3))).toEqual(
      nextGridPosition(graphWithNodeCount(3)),
    );
  });

  it("wraps into a new row after the configured column count", () => {
    const first = nextGridPosition(graphWithNodeCount(0));
    const wrapped = nextGridPosition(graphWithNodeCount(4));
    expect(wrapped.x).toBe(first.x);
    expect(wrapped.y).toBeGreaterThan(first.y);
  });
});
