import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { CATEGORY_COLORS, NODE_TYPE_MAP } from "../../../../catalog";
import * as mockXyflow from "../../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { CFNode } = await import("./CFNode");

/** Minimal props shape accepted by the unwrapped `CFNodeComponent`, for test rendering only. */
interface TestNodeProps {
  data: Record<string, unknown>;
  selected: boolean;
}

/** Render `CFNode` (unwrapped from `memo()`) with the given node data. */
function renderCFNode(data: Record<string, unknown>, selected = false) {
  const Unwrapped = (
    CFNode as unknown as { type: ComponentType<TestNodeProps> }
  ).type;
  return render(<Unwrapped data={data} selected={selected} />);
}

/**
 * Convert a `#rrggbb` color plus a `66` (40%) alpha suffix -- the unselected border style
 * `CFNode` always renders -- into the `rgba(...)` string jsdom's `CSSStyleDeclaration` getter
 * normalises inline hex-with-alpha colors to, so assertions can compare against it directly.
 */
function unselectedBorderColor(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, 0.4)`;
}

describe("CFNode", () => {
  it("renders the node label", () => {
    renderCFNode({ typeId: "worker", label: "My Worker" });
    expect(screen.getByText("My Worker")).toBeInTheDocument();
  });

  it("renders a description when set", () => {
    renderCFNode({
      typeId: "worker",
      label: "W",
      description: "Handles requests",
    });
    expect(screen.getByText("Handles requests")).toBeInTheDocument();
  });

  it("omits the description block when absent", () => {
    const { container } = renderCFNode({ typeId: "worker", label: "W" });
    expect(container.querySelector(".cf-node__description")).toBeNull();
  });

  it("renders the catalog icon for a known typeId", () => {
    const { container } = renderCFNode({ typeId: "d1", label: "DB" });
    expect(container.querySelector("img.cf-node__icon")).toHaveAttribute(
      "src",
      "/icons/d1.svg",
    );
  });

  it("falls back to the worker icon for an unknown typeId", () => {
    const { container } = renderCFNode({
      typeId: "does-not-exist",
      label: "X",
    });
    expect(container.querySelector("img.cf-node__icon")).toHaveAttribute(
      "src",
      "/icons/worker.svg",
    );
  });

  it("renders one handle per catalog default handle", () => {
    renderCFNode({ typeId: "cron-trigger", label: "Cron" });
    const typeDef = NODE_TYPE_MAP.get("cron-trigger");
    expect(typeDef?.defaultHandles).toHaveLength(2);
    for (const handle of typeDef?.defaultHandles ?? []) {
      expect(screen.getByTestId(`handle-${handle.id}`)).toBeInTheDocument();
    }
  });

  it("uses the category color when no accent override is set", () => {
    const { container } = renderCFNode({ typeId: "d1", label: "DB" });
    const node = container.querySelector(".cf-node") as HTMLElement;
    expect(node.style.borderColor).toBe(
      unselectedBorderColor(CATEGORY_COLORS.storage),
    );
  });

  it("prefers a custom accentColor over the category color", () => {
    const { container } = renderCFNode({
      typeId: "worker",
      label: "W",
      style: { accentColor: "#ff0000" },
    });
    const node = container.querySelector(".cf-node") as HTMLElement;
    expect(node.style.borderColor).toBe(unselectedBorderColor("#ff0000"));
  });

  it("shows a selection box-shadow only when selected", () => {
    const { container: unselected } = renderCFNode(
      { typeId: "worker", label: "W" },
      false,
    );
    expect(
      (unselected.querySelector(".cf-node") as HTMLElement).style.boxShadow,
    ).toBe("none");

    const { container: selected } = renderCFNode(
      { typeId: "worker", label: "W" },
      true,
    );
    expect(
      (selected.querySelector(".cf-node") as HTMLElement).style.boxShadow,
    ).not.toBe("none");
  });
});
