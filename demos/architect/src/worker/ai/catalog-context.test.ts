import { describe, expect, it } from "vitest";
import { EDGE_TYPES, NODE_TYPES } from "../../catalog";
import type { GraphData } from "../diagrams/types";
import { buildCatalogPromptContext, nextGridPosition } from "./catalog-context";

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
