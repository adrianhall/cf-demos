import { describe, expect, it } from "vitest";
import { BLUEPRINT_MAP, BLUEPRINTS } from "./blueprints";
import { NODE_TYPE_MAP } from "./catalog";

/** Minimal shape of a blueprint's parsed `graphData`, enough to validate cross-references. */
interface ParsedGraph {
  nodes: { id: string; data: { typeId: string } }[];
  edges: { id: string; source: string; target: string }[];
  viewport: { x: number; y: number; zoom: number };
}

describe("blueprints", () => {
  it("has a unique id for every blueprint", () => {
    const ids = BLUEPRINTS.map((blueprint) => blueprint.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes every blueprint by id in BLUEPRINT_MAP", () => {
    for (const blueprint of BLUEPRINTS) {
      expect(BLUEPRINT_MAP.get(blueprint.id)).toBe(blueprint);
    }
    expect(BLUEPRINT_MAP.get("does-not-exist")).toBeUndefined();
  });

  it("serialises graphData as valid JSON with nodes, edges, and a viewport", () => {
    for (const blueprint of BLUEPRINTS) {
      const parsed = JSON.parse(blueprint.graphData) as ParsedGraph;
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);
      expect(parsed.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(parsed.nodes.length).toBeGreaterThan(0);
    }
  });

  it("references only catalog node types that actually exist", () => {
    for (const blueprint of BLUEPRINTS) {
      const parsed = JSON.parse(blueprint.graphData) as ParsedGraph;
      for (const node of parsed.nodes) {
        expect(NODE_TYPE_MAP.has(node.data.typeId)).toBe(true);
      }
    }
  });

  it("connects every edge to node ids that exist within the same blueprint", () => {
    for (const blueprint of BLUEPRINTS) {
      const parsed = JSON.parse(blueprint.graphData) as ParsedGraph;
      const nodeIds = new Set(parsed.nodes.map((node) => node.id));
      for (const edge of parsed.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
      }
    }
  });
});
