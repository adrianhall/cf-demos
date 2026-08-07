import { describe, expect, it } from "vitest";
import { acceptEdgeUpdate, acceptNodeUpdate, cloneGraph, createProductNode, initialGraph, parseGraph, serializeGraph } from "./store";

describe("graph document", () => {
  it("contains five palette products, an external actor, and two typed labeled edges", async () => {
    const { catalog } = await import("./catalog");
    expect(catalog).toHaveLength(5);
    expect(initialGraph.nodes.some((node) => node.type === "actor")).toBe(true);
    expect(initialGraph.edges.map((edge) => `${edge.type}:${edge.data?.label}`)).toEqual(["request:HTTPS request", "event:persist diagram"]);
  });

  it("round trips graph JSON and creates palette nodes at graph coordinates", () => {
    const graph = cloneGraph(initialGraph);
    const restored = parseGraph(serializeGraph(graph));
    expect(restored).toEqual(graph);
    expect(createProductNode("r2", { x: 125, y: 225 })).toMatchObject({ type: "product", position: { x: 125, y: 225 }, data: { productId: "r2" } });
  });

  it("rejects every canvas node and edge update in read-only mode", () => {
    expect(acceptNodeUpdate(true, initialGraph.nodes)).toBeUndefined();
    expect(acceptEdgeUpdate(true, initialGraph.edges)).toBeUndefined();
    expect(acceptNodeUpdate(false, initialGraph.nodes)).toEqual(initialGraph.nodes);
  });
});
