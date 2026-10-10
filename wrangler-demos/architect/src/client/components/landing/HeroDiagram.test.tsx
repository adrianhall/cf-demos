import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeroDiagram, resolveNodeType } from "./HeroDiagram";

describe("resolveNodeType", () => {
  it("resolves a real catalog product type", () => {
    expect(resolveNodeType("worker").label).toBe("Workers");
  });

  it("throws on an unknown type id instead of silently omitting the node", () => {
    expect(() => resolveNodeType("not-a-real-product")).toThrow(
      /unknown catalog product type/,
    );
  });
});

describe("HeroDiagram", () => {
  it("is hidden from assistive technology, since it duplicates the surrounding hero copy", () => {
    const { container } = render(<HeroDiagram />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("renders one node chip per catalog product in the illustration", () => {
    const { container } = render(<HeroDiagram />);

    const nodes = container.querySelectorAll(".cf-node");
    expect(nodes).toHaveLength(4);
  });

  it("renders a labeled node for each real catalog product it illustrates", () => {
    const { container } = render(<HeroDiagram />);

    const labels = Array.from(
      container.querySelectorAll(".cf-node__label"),
    ).map((label) => label.textContent);
    expect(labels).toEqual([
      "Client (Browser)",
      "Workers",
      "D1 Database",
      "Workers KV",
    ]);
  });

  it("connects the nodes with the same number of edges it declares", () => {
    const { container } = render(<HeroDiagram />);

    // Scoped to the connector `<svg>` itself (a direct child of `.landing__hero-visual`) rather
    // than every `<svg> line` in the tree: each `react-feather` node icon is its own nested
    // `<svg>` and some glyphs (e.g. "Monitor") are themselves built from `<line>` elements.
    const connectors = container.querySelector(".landing__hero-visual > svg");
    expect(connectors?.querySelectorAll("line")).toHaveLength(3);
  });
});
