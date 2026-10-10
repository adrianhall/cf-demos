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
 * Convert a `#rrggbb` color into the `rgb(...)` string jsdom's `CSSStyleDeclaration` getter
 * normalises an inline hex color to, so assertions can compare against it directly. `CFNode`
 * renders its border at full opacity in both the selected and unselected states (see
 * `CFNode.tsx`'s Bug 10 fix comment) -- selection is distinguished by the box-shadow ring
 * instead, covered by the "shows a selection box-shadow only when selected" test below.
 */
function borderColor(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
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
    // `d1.svg`'s own `viewBox` ("0 0 65 64") uniquely identifies it among the vendored icons
    // (`../../../../catalog.ts`'s Issue 7 fix), distinguishing it from the "workers" glyph
    // (`viewBox="0 0 48 49"`) the fallback test below asserts against.
    const { container } = renderCFNode({ typeId: "d1", label: "DB" });
    const icon = container.querySelector(".cf-node__icon");
    expect(icon).toHaveClass("product-icon--svg");
    expect(icon?.innerHTML).toContain('viewBox="0 0 65 64"');
  });

  it("falls back to the workers icon and external category color for an unknown typeId", () => {
    const { container } = renderCFNode({
      typeId: "does-not-exist",
      label: "X",
    });
    const icon = container.querySelector(".cf-node__icon");
    expect(icon?.innerHTML).toContain('viewBox="0 0 48 49"');
    const node = container.querySelector(".cf-node") as HTMLElement;
    expect(node.style.borderColor).toBe(borderColor(CATEGORY_COLORS.external));
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
    expect(node.style.borderColor).toBe(borderColor(CATEGORY_COLORS.storage));
  });

  it("prefers a custom accentColor over the category color", () => {
    const { container } = renderCFNode({
      typeId: "worker",
      label: "W",
      style: { accentColor: "#ff0000" },
    });
    const node = container.querySelector(".cf-node") as HTMLElement;
    expect(node.style.borderColor).toBe(borderColor("#ff0000"));
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
