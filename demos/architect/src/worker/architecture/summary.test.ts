import { describe, expect, it } from "vitest";
import { emptyGraphDocument } from "../../graph/blueprints";
import { buildCatalogSummary } from "./summary";

describe("buildCatalogSummary", () => {
  it("lists the full curated catalog", () => {
    const summary = buildCatalogSummary(emptyGraphDocument);
    expect(summary).toContain("Workers");
    expect(summary).toContain("id: workers");
    expect(summary).toContain("id: d1");
    expect(summary).toContain("id: r2");
    expect(summary).toContain("id: kv");
    expect(summary).toContain("id: workflows");
  });

  it("notes an empty diagram explicitly", () => {
    const summary = buildCatalogSummary(emptyGraphDocument);
    expect(summary).toContain("(the diagram is currently empty)");
    expect(summary).toContain("0 node(s) and 0 edge(s)");
  });

  it("summarizes existing product and actor nodes without full edge detail", () => {
    const document = {
      ...emptyGraphDocument,
      nodes: [
        {
          id: "n1",
          type: "product" as const,
          position: { x: 0, y: 0 },
          data: {
            productId: "workers" as const,
            label: "API",
            description: "",
          },
        },
        {
          id: "n2",
          type: "actor" as const,
          position: { x: 1, y: 1 },
          data: { kind: "external-actor" as const, label: "Client" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "n2",
          target: "n1",
          type: "request" as const,
          data: { relationship: "request" as const, label: "request" },
        },
      ],
    };
    const summary = buildCatalogSummary(document);
    expect(summary).toContain("product workers: API");
    expect(summary).toContain("external actor: Client");
    expect(summary).toContain("2 node(s) and 1 edge(s)");
  });
});
