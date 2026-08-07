import { describe, expect, it } from "vitest";
import {
  architectureProposalJsonSchema,
  architectureProposalToGraphDocument,
  validateArchitectureProposal,
} from "./proposal";
import { GraphValidationError } from "./validation";

const validProposal = {
  title: "Simple API",
  nodes: [
    { id: "client", type: "actor", label: "Client application" },
    {
      id: "api",
      type: "product",
      productId: "workers",
      label: "API Worker",
      description: "Handles requests",
    },
  ],
  edges: [
    {
      id: "request",
      source: "client",
      target: "api",
      type: "request",
      label: "HTTPS request",
    },
  ],
};

describe("architectureProposalJsonSchema", () => {
  it("constrains product ids to the curated catalog", () => {
    expect(
      architectureProposalJsonSchema.properties.nodes.items.properties.productId
        .enum,
    ).toEqual(["workers", "d1", "r2", "kv", "workflows"]);
  });

  it("bounds node and edge counts matching Spike 09's measured schema", () => {
    expect(architectureProposalJsonSchema.properties.nodes.minItems).toBe(2);
    expect(architectureProposalJsonSchema.properties.nodes.maxItems).toBe(8);
    expect(architectureProposalJsonSchema.properties.edges.maxItems).toBe(10);
  });

  it("forbids additional properties at every level", () => {
    expect(architectureProposalJsonSchema.additionalProperties).toBe(false);
    expect(
      architectureProposalJsonSchema.properties.nodes.items
        .additionalProperties,
    ).toBe(false);
    expect(
      architectureProposalJsonSchema.properties.edges.items
        .additionalProperties,
    ).toBe(false);
  });
});

describe("validateArchitectureProposal", () => {
  it("accepts a well-formed proposal", () => {
    const proposal = validateArchitectureProposal(validProposal);
    expect(proposal.title).toBe("Simple API");
    expect(proposal.nodes).toHaveLength(2);
    expect(proposal.edges).toHaveLength(1);
  });

  it("rejects a non-object value", () => {
    expect(() => validateArchitectureProposal("not an object")).toThrow(
      GraphValidationError,
    );
  });

  it("rejects fewer than 2 nodes", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        nodes: [validProposal.nodes[0]],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects more than 8 nodes", () => {
    const manyNodes = Array.from({ length: 9 }, (_, index) => ({
      id: `n${index}`,
      type: "actor",
      label: `Node ${index}`,
    }));
    expect(() =>
      validateArchitectureProposal({ ...validProposal, nodes: manyNodes }),
    ).toThrow(GraphValidationError);
  });

  it("rejects more than 10 edges", () => {
    const manyEdges = Array.from({ length: 11 }, (_, index) => ({
      id: `e${index}`,
      source: "client",
      target: "api",
      type: "request",
      label: `Edge ${index}`,
    }));
    expect(() =>
      validateArchitectureProposal({ ...validProposal, edges: manyEdges }),
    ).toThrow(GraphValidationError);
  });

  it("rejects an unknown catalog product, never silently mapping it to a curated one", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        nodes: [
          validProposal.nodes[0],
          {
            id: "mystery",
            type: "product",
            productId: "not-real",
            label: "Mystery",
          },
        ],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects a product node missing productId", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        nodes: [
          validProposal.nodes[0],
          { id: "mystery", type: "product", label: "Mystery" },
        ],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        nodes: [validProposal.nodes[0], { ...validProposal.nodes[0] }],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects duplicate edge ids", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        edges: [validProposal.edges[0], { ...validProposal.edges[0] }],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects an unsupported node type", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        nodes: [
          validProposal.nodes[0],
          { id: "x", type: "server", label: "X" },
        ],
      }),
    ).toThrow(GraphValidationError);
  });

  it("rejects an unsupported edge type", () => {
    expect(() =>
      validateArchitectureProposal({
        ...validProposal,
        edges: [{ ...validProposal.edges[0], type: "sync" }],
      }),
    ).toThrow(GraphValidationError);
  });
});

describe("architectureProposalToGraphDocument", () => {
  it("assigns a deterministic grid position to every node", () => {
    const document = architectureProposalToGraphDocument(
      validateArchitectureProposal(validProposal),
    );
    expect(document.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(document.nodes[1]?.position).toEqual({ x: 240, y: 0 });
  });

  it("defaults a product node's description to an empty string when omitted", () => {
    const document = architectureProposalToGraphDocument(
      validateArchitectureProposal({
        ...validProposal,
        nodes: [
          validProposal.nodes[0],
          { id: "api", type: "product", productId: "workers", label: "API" },
        ],
      }),
    );
    const apiNode = document.nodes.find((node) => node.id === "api");
    expect(apiNode?.data).toMatchObject({ description: "" });
  });

  it("produces a document that passes the shared validateGraphDocument", () => {
    const document = architectureProposalToGraphDocument(
      validateArchitectureProposal(validProposal),
    );
    expect(document.version).toBe(1);
    expect(document.edges).toHaveLength(1);
  });

  it("rejects an edge with a dangling endpoint via the shared graph validation", () => {
    const proposal = validateArchitectureProposal({
      title: "Dangling",
      nodes: [validProposal.nodes[0], validProposal.nodes[1]],
      edges: [
        {
          id: "e1",
          source: "client",
          target: "does-not-exist",
          type: "request",
          label: "x",
        },
      ],
    });
    expect(() => architectureProposalToGraphDocument(proposal)).toThrow(
      GraphValidationError,
    );
  });
});
