import type { Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  chooseConnectionHandles,
  findDuplicateEdge,
  validateConnection,
} from "./connect";
import type { CFEdgeData, CFNodeData } from "./types";

/** Build a minimal node fixture at a given position with the given catalog `typeId`. */
function node(
  id: string,
  typeId: string,
  position: { x: number; y: number },
): Node<CFNodeData> {
  return {
    data: { label: id, typeId },
    id,
    position,
  } as Node<CFNodeData>;
}

describe("chooseConnectionHandles", () => {
  it("prefers right/left handles when the target is to the right and the horizontal distance dominates", () => {
    const source = node("a", "worker", { x: 0, y: 0 });
    const target = node("b", "worker", { x: 300, y: 10 });
    expect(chooseConnectionHandles(source, target)).toEqual({
      sourceHandle: "source-right",
      targetHandle: "target-left",
    });
  });

  it("prefers bottom/top handles when the target is below and the vertical distance dominates", () => {
    const source = node("a", "worker", { x: 0, y: 0 });
    const target = node("b", "worker", { x: 10, y: 300 });
    expect(chooseConnectionHandles(source, target)).toEqual({
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
    });
  });

  it("falls back to bottom/top when the target is to the left, even though the horizontal distance dominates", () => {
    // The catalog's default handle set has no "source-left"/"target-right" pair (see
    // "../../../catalog.ts" and "./toolbar/Toolbar.tsx"'s `remapEdgeHandles`), so a target to
    // the left never gets a direct handle match and falls through to the vertical pair instead.
    const source = node("a", "worker", { x: 300, y: 0 });
    const target = node("b", "worker", { x: 0, y: 10 });
    expect(chooseConnectionHandles(source, target)).toEqual({
      sourceHandle: "source-bottom",
      targetHandle: "target-top",
    });
  });

  it("falls back to the node type's first declared source handle when the preferred one isn't declared", () => {
    // "cron-trigger" declares only source-bottom/source-right -- both a preferred match here.
    const source = node("a", "cron-trigger", { x: 0, y: 0 });
    const target = node("b", "worker", { x: 10, y: 300 });
    const { sourceHandle } = chooseConnectionHandles(source, target);
    expect(sourceHandle).toBe("source-bottom");
  });

  it("falls back to null when the target type declares no target handle at all", () => {
    // "client-browser" declares only source handles, never a target handle.
    const source = node("a", "worker", { x: 0, y: 0 });
    const target = node("b", "client-browser", { x: 10, y: 300 });
    const { targetHandle } = chooseConnectionHandles(source, target);
    expect(targetHandle).toBeNull();
  });

  it("falls back to null for both handles when the type isn't in the catalog at all", () => {
    const source = node("a", "not-a-real-type", { x: 0, y: 0 });
    const target = node("b", "also-not-real", { x: 10, y: 300 });
    expect(chooseConnectionHandles(source, target)).toEqual({
      sourceHandle: null,
      targetHandle: null,
    });
  });
});

describe("findDuplicateEdge", () => {
  const edges = [
    {
      data: { edgeType: "data-flow" } as CFEdgeData,
      id: "e1",
      source: "a",
      target: "b",
    },
  ];

  it("finds an edge with the same source, target, and edge type", () => {
    expect(findDuplicateEdge(edges, "a", "b", "data-flow")).toBe(edges[0]);
  });

  it("does not consider the same source/target pair with a different edge type a duplicate", () => {
    expect(findDuplicateEdge(edges, "a", "b", "trigger")).toBeUndefined();
  });

  it("does not match a reversed source/target pair", () => {
    expect(findDuplicateEdge(edges, "b", "a", "data-flow")).toBeUndefined();
  });
});

describe("validateConnection", () => {
  const edges = [
    {
      data: { edgeType: "data-flow" } as CFEdgeData,
      id: "e1",
      source: "a",
      target: "b",
    },
  ];

  it("rejects connecting a node to itself", () => {
    expect(
      validateConnection({
        edgeType: "data-flow",
        edges: [],
        sourceId: "a",
        targetId: "a",
      }),
    ).toBe("A node cannot be connected to itself.");
  });

  it("rejects a duplicate source/target/edge-type combination", () => {
    expect(
      validateConnection({
        edgeType: "data-flow",
        edges,
        sourceId: "a",
        targetId: "b",
      }),
    ).toBe("These nodes are already connected with that edge type.");
  });

  it("allows the same source/target pair with a different edge type", () => {
    expect(
      validateConnection({
        edgeType: "trigger",
        edges,
        sourceId: "a",
        targetId: "b",
      }),
    ).toBeNull();
  });

  it("allows a valid, non-duplicate connection", () => {
    expect(
      validateConnection({
        edgeType: "data-flow",
        edges,
        sourceId: "a",
        targetId: "c",
      }),
    ).toBeNull();
  });
});
