import { describe, expect, it } from "vitest";
import { emptyGraphDocument } from "./blueprints";
import { GraphValidationError, validateGraphDocument } from "./validation";

/** Build a minimal valid document with one product node for mutation in tests. */
function baseDocument() {
  return {
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
}

describe("validateGraphDocument", () => {
  it("accepts a well-formed document", () => {
    const document = validateGraphDocument(baseDocument());
    expect(document.nodes).toHaveLength(2);
    expect(document.edges).toHaveLength(1);
  });

  it("accepts the shared empty document", () => {
    expect(validateGraphDocument(emptyGraphDocument)).toEqual(
      emptyGraphDocument,
    );
  });

  it.each([
    ["a non-object value", "not-a-document"],
    ["a wrong version", { ...baseDocument(), version: 2 }],
    ["a non-array nodes field", { ...baseDocument(), nodes: {} }],
    ["a non-array edges field", { ...baseDocument(), edges: {} }],
    ["a malformed viewport", { ...baseDocument(), viewport: { x: 0, y: 0 } }],
  ])("rejects %s", (_label, candidate) => {
    expect(() => validateGraphDocument(candidate)).toThrow(
      GraphValidationError,
    );
  });

  it("rejects a node with an unknown catalog product", () => {
    const document = baseDocument();
    document.nodes[0].data = {
      productId: "unknown-product",
      label: "Bad",
      description: "",
    };
    expect(() => validateGraphDocument(document)).toThrow(
      /unknown catalog product/,
    );
  });

  it("rejects a product node missing a label", () => {
    const document = baseDocument();
    document.nodes[0].data = {
      productId: "workers",
      label: "",
      description: "",
    };
    expect(() => validateGraphDocument(document)).toThrow(/non-empty label/);
  });

  it("rejects an actor node with the wrong kind marker", () => {
    const document = baseDocument();
    document.nodes[1].data = { kind: "product", label: "Browser" };
    expect(() => validateGraphDocument(document)).toThrow(/external-actor/);
  });

  it("rejects an unsupported node type", () => {
    const document = baseDocument();
    document.nodes[0].type = "annotation";
    expect(() => validateGraphDocument(document)).toThrow(/unsupported type/);
  });

  it("rejects a duplicate node id", () => {
    const document = baseDocument();
    document.nodes[1].id = document.nodes[0].id;
    expect(() => validateGraphDocument(document)).toThrow(/Duplicate node/);
  });

  it("rejects a duplicate edge id", () => {
    const document = baseDocument();
    document.edges.push({ ...document.edges[0] });
    expect(() => validateGraphDocument(document)).toThrow(/Duplicate edge/);
  });

  it("rejects a self-loop edge", () => {
    const document = baseDocument();
    document.edges[0].source = document.edges[0].target;
    expect(() => validateGraphDocument(document)).toThrow(/itself/);
  });

  it("rejects an edge referencing an unknown source node", () => {
    const document = baseDocument();
    document.edges[0].source = "missing-node";
    expect(() => validateGraphDocument(document)).toThrow(/unknown source/);
  });

  it("rejects an edge referencing an unknown target node", () => {
    const document = baseDocument();
    document.edges[0].target = "missing-node";
    expect(() => validateGraphDocument(document)).toThrow(/unknown target/);
  });

  it("rejects an edge with an unsupported type", () => {
    const document = baseDocument();
    document.edges[0].type = "annotation";
    expect(() => validateGraphDocument(document)).toThrow(/unsupported type/);
  });
});
