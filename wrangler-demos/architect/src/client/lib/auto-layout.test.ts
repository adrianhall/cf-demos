import { describe, expect, it, vi } from "vitest";

const { mockElkLayout } = vi.hoisted(() => ({ mockElkLayout: vi.fn() }));
vi.mock("elkjs/lib/elk.bundled.js", () => ({
  default: class MockElk {
    layout = mockElkLayout;
  },
}));

const { computeAutoLayout, remapEdgeHandles } = await import("./auto-layout");

describe("remapEdgeHandles", () => {
  const nodes = [
    {
      data: { label: "A", typeId: "worker" },
      id: "a",
      position: { x: 0, y: 0 },
    },
    {
      data: { label: "B", typeId: "worker" },
      id: "b",
      position: { x: 0, y: 0 },
    },
  ];

  it("remaps to bottom/top handles for a DOWN layout", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    const [remapped] = remapEdgeHandles(edges, nodes, "DOWN");
    expect(remapped).toMatchObject({
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
    });
  });

  it("remaps to right/left handles for a RIGHT layout", () => {
    const edges = [{ id: "e1", source: "a", target: "b" }];
    const [remapped] = remapEdgeHandles(edges, nodes, "RIGHT");
    expect(remapped).toMatchObject({
      sourceHandle: "source-right",
      targetHandle: "target-left",
    });
  });

  it("returns the same edge instance when the computed handles already match", () => {
    const edge = {
      id: "e1",
      source: "a",
      sourceHandle: "source-bottom",
      target: "b",
      targetHandle: "target-top",
    };
    const [remapped] = remapEdgeHandles([edge], nodes, "DOWN");
    expect(remapped).toBe(edge);
  });

  it("leaves an edge unchanged when it references a node id not present in the diagram", () => {
    const edges = [
      {
        id: "e1",
        source: "missing-source",
        sourceHandle: "custom-source",
        target: "missing-target",
        targetHandle: "custom-target",
      },
    ];
    const [remapped] = remapEdgeHandles(edges, nodes, "DOWN");
    expect(remapped).toMatchObject({
      sourceHandle: "custom-source",
      targetHandle: "custom-target",
    });
  });
});

describe("computeAutoLayout", () => {
  it("builds an ELK graph from the given nodes/edges and returns repositioned nodes", async () => {
    mockElkLayout.mockReset().mockResolvedValue({
      children: [{ id: "a", x: 42, y: 99 }],
    });

    const nodes = [
      {
        data: { label: "A", typeId: "worker" },
        id: "a",
        position: { x: 0, y: 0 },
      },
    ];
    const result = await computeAutoLayout(nodes, [], "DOWN");

    expect(result?.nodes[0]?.position).toEqual({ x: 42, y: 99 });
    expect(mockElkLayout).toHaveBeenCalledTimes(1);
  });

  it("threads edges into the ELK graph description", async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    const nodes = [
      {
        data: { label: "A", typeId: "worker" },
        id: "a",
        position: { x: 0, y: 0 },
      },
      {
        data: { label: "B", typeId: "worker" },
        id: "b",
        position: { x: 0, y: 0 },
      },
    ];
    const edges = [{ id: "e1", source: "a", target: "b" }];

    await computeAutoLayout(nodes, edges, "DOWN");

    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.edges).toEqual([{ id: "e1", sources: ["a"], targets: ["b"] }]);
  });

  it("threads catalog handle ports into the ELK graph for a node with default handles", async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    const nodes = [
      {
        data: { label: "A", typeId: "cron-trigger" },
        id: "a",
        position: { x: 0, y: 0 },
      },
    ];

    await computeAutoLayout(nodes, [], "DOWN");

    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.children[0].ports.length).toBeGreaterThan(0);
  });

  it("gives a node with an unrecognized catalog type no ports at all", async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    const nodes = [
      {
        data: { label: "A", typeId: "not-a-real-type" },
        id: "a",
        position: { x: 0, y: 0 },
      },
    ];

    await computeAutoLayout(nodes, [], "DOWN");

    const graph = mockElkLayout.mock.calls[0]?.[0];
    expect(graph.children[0].ports).toHaveLength(0);
  });

  it("defaults a computed position's missing x/y to 0", async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [{ id: "a" }] });

    const nodes = [
      {
        data: { label: "A", typeId: "worker" },
        id: "a",
        position: { x: 9, y: 9 },
      },
    ];
    const result = await computeAutoLayout(nodes, [], "DOWN");

    expect(result?.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("leaves an unmatched node's position untouched", async () => {
    mockElkLayout.mockReset().mockResolvedValue({ children: [] });

    const nodes = [
      {
        data: { label: "A", typeId: "worker" },
        id: "a",
        position: { x: 1, y: 2 },
      },
    ];
    const result = await computeAutoLayout(nodes, [], "DOWN");

    expect(result?.nodes[0]?.position).toEqual({ x: 1, y: 2 });
  });

  it("returns null when ELK's response carries no children", async () => {
    mockElkLayout.mockReset().mockResolvedValue({});

    const result = await computeAutoLayout(
      [
        {
          data: { label: "A", typeId: "worker" },
          id: "a",
          position: { x: 1, y: 2 },
        },
      ],
      [],
      "DOWN",
    );

    expect(result).toBeNull();
  });

  it("propagates a thrown ELK layout error to the caller", async () => {
    mockElkLayout.mockReset().mockRejectedValue(new Error("layout failed"));

    await expect(computeAutoLayout([], [], "DOWN")).rejects.toThrow(
      "layout failed",
    );
  });
});
