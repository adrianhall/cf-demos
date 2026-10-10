import { describe, expect, it } from "vitest";
import { describeOperation } from "./describe-operation";

describe("describeOperation", () => {
  const nodes = [
    {
      data: { label: "Workers", typeId: "worker" },
      id: "n1",
      position: { x: 0, y: 0 },
    },
    {
      data: { label: "D1 Database", typeId: "d1" },
      id: "n2",
      position: { x: 100, y: 0 },
    },
  ];
  const edges = [
    {
      data: { edgeType: "service-binding" as const },
      id: "e1",
      source: "n1",
      target: "n2",
    },
  ];

  it("describes add_node using the operation's own label", () => {
    expect(
      describeOperation(
        {
          input: {
            label: "Workers",
            position: { x: 0, y: 0 },
            typeId: "worker",
          },
          kind: "add_node",
        },
        [],
        [],
      ),
    ).toBe("Added node: Workers");
  });

  it("describes update_node using the patch's label when present", () => {
    expect(
      describeOperation(
        { kind: "update_node", nodeId: "n1", patch: { label: "Renamed" } },
        nodes,
        [],
      ),
    ).toBe("Updated node: Renamed");
  });

  it("describes update_node falling back to the current node's label", () => {
    expect(
      describeOperation(
        {
          kind: "update_node",
          nodeId: "n1",
          patch: { position: { x: 5, y: 5 } },
        },
        nodes,
        [],
      ),
    ).toBe("Updated node: Workers");
  });

  it("describes remove_node using the (still-present) current node's label", () => {
    expect(
      describeOperation({ kind: "remove_node", nodeId: "n1" }, nodes, []),
    ).toBe("Removed node: Workers");
  });

  it("falls back to a generic label for remove_node targeting an unknown node id", () => {
    expect(
      describeOperation({ kind: "remove_node", nodeId: "missing" }, nodes, []),
    ).toBe("Removed node: a node");
  });

  it("describes add_edge with both endpoint labels and the edge type label", () => {
    expect(
      describeOperation(
        {
          input: { edgeType: "service-binding", source: "n1", target: "n2" },
          kind: "add_edge",
        },
        nodes,
        [],
      ),
    ).toBe("Connected Workers → D1 Database (Service Binding)");
  });

  it("describes update_edge using the existing edge's endpoints and patched edge type", () => {
    expect(
      describeOperation(
        { edgeId: "e1", kind: "update_edge", patch: { edgeType: "trigger" } },
        nodes,
        edges,
      ),
    ).toBe("Updated connection: Workers → D1 Database (Trigger)");
  });

  it("describes update_edge falling back to the existing edge type when the patch omits it", () => {
    expect(
      describeOperation(
        { edgeId: "e1", kind: "update_edge", patch: { label: "renamed" } },
        nodes,
        edges,
      ),
    ).toBe("Updated connection: Workers → D1 Database (Service Binding)");
  });

  it("falls back to the raw edgeType string for an unrecognized catalog edge type", () => {
    expect(
      describeOperation(
        {
          input: {
            edgeType: "not-a-real-edge-type",
            source: "n1",
            target: "n2",
          },
          kind: "add_edge",
        },
        nodes,
        [],
      ),
    ).toBe("Connected Workers → D1 Database (not-a-real-edge-type)");
  });

  it("defaults update_edge's edge type to data-flow when neither the patch nor the (missing) edge has one", () => {
    expect(
      describeOperation(
        { edgeId: "missing", kind: "update_edge", patch: {} },
        nodes,
        [],
      ),
    ).toBe("Updated connection (Data Flow)");
  });

  it("describes update_edge for an unknown edge id without endpoint labels", () => {
    expect(
      describeOperation(
        {
          edgeId: "missing",
          kind: "update_edge",
          patch: { edgeType: "trigger" },
        },
        nodes,
        edges,
      ),
    ).toBe("Updated connection (Trigger)");
  });

  it("describes remove_edge using the (still-present) current edge's endpoints", () => {
    expect(
      describeOperation({ edgeId: "e1", kind: "remove_edge" }, nodes, edges),
    ).toBe("Removed connection: Workers → D1 Database");
  });

  it("falls back to a generic label for remove_edge targeting an unknown edge id", () => {
    expect(
      describeOperation(
        { edgeId: "missing", kind: "remove_edge" },
        nodes,
        edges,
      ),
    ).toBe("Removed connection");
  });
});
