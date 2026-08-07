import { describe, expect, it } from "vitest";
import { layoutGraph } from "./layout";
import { cloneGraph, initialGraph } from "./store";

describe("ELK layout", () => {
  it("returns one finite position for every node without changing graph semantics", async () => {
    const laidOut = await layoutGraph(cloneGraph(initialGraph));
    expect(laidOut.edges).toEqual(initialGraph.edges);
    expect(laidOut.nodes).toHaveLength(initialGraph.nodes.length);
    for (const node of laidOut.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });
});
