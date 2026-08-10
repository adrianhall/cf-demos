import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { CFEdge } = await import("./CFEdge");

/** Minimal props shape accepted by the unwrapped `CFEdgeComponent`, for test rendering only. */
interface TestEdgeProps {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: string;
  targetPosition: string;
  data?: Record<string, unknown>;
  selected?: boolean;
}

/** Render `CFEdge` (unwrapped from `memo()`) with the given edge data. */
function renderCFEdge(data?: Record<string, unknown>, selected = false) {
  const Unwrapped = (
    CFEdge as unknown as { type: ComponentType<TestEdgeProps> }
  ).type;
  return render(
    <Unwrapped
      id="test-edge"
      sourceX={0}
      sourceY={0}
      targetX={100}
      targetY={100}
      sourcePosition={mockXyflow.Position.Bottom}
      targetPosition={mockXyflow.Position.Top}
      data={data}
      selected={selected}
    />,
  );
}

describe("CFEdge", () => {
  it("defaults to the data-flow edge type when data is absent", () => {
    const { container } = renderCFEdge();
    expect(
      container.querySelector("path[data-testid='base-edge']"),
    ).toBeInTheDocument();
  });

  it("falls back to a neutral gray stroke for an unrecognized edge type", () => {
    const { container } = renderCFEdge({ edgeType: "not-a-real-type" });
    const path = container.querySelector(
      "path[data-testid='base-edge']",
    ) as SVGPathElement;
    expect(path.style.stroke).toBe("rgb(156, 163, 175)");
  });

  it("renders a dashed stroke for service-binding edges", () => {
    const { container } = renderCFEdge({ edgeType: "service-binding" });
    const path = container.querySelector(
      "path[data-testid='base-edge']",
    ) as SVGPathElement;
    expect(path.style.strokeDasharray).toBe("8 4");
  });

  it("renders a dotted stroke for trigger edges", () => {
    const { container } = renderCFEdge({ edgeType: "trigger" });
    const path = container.querySelector(
      "path[data-testid='base-edge']",
    ) as SVGPathElement;
    expect(path.style.strokeDasharray).toBe("3 3");
  });

  it("renders a solid stroke with no dash array for data-flow edges", () => {
    const { container } = renderCFEdge({ edgeType: "data-flow" });
    const path = container.querySelector(
      "path[data-testid='base-edge']",
    ) as SVGPathElement;
    expect(path.style.strokeDasharray).toBe("");
  });

  it("renders a label when set", () => {
    renderCFEdge({ edgeType: "data-flow", label: "HTTPS" });
    expect(screen.getByText("HTTPS")).toBeInTheDocument();
  });

  it("renders no label element when absent", () => {
    const { queryByTestId } = renderCFEdge({ edgeType: "data-flow" });
    expect(queryByTestId("edge-label-renderer")).toBeNull();
  });

  it("uses a thicker stroke and the selected accent color when selected", () => {
    const { container } = renderCFEdge({ edgeType: "data-flow" }, true);
    const path = container.querySelector(
      "path[data-testid='base-edge']",
    ) as SVGPathElement;
    expect(path.style.strokeWidth).toBe("2.5");
    expect(path.style.stroke).toBe("rgb(246, 130, 31)");
  });

  it("marks the edge as animated only for edge types configured as animated (Bug 24)", () => {
    // `cf-edge-animated` (not `@xyflow/react`'s own `react-flow__edge-animated`-shaped naming)
    // is this app's own class -- see `CFEdge.tsx`'s Bug 24 comment for why a class matching
    // `@xyflow/react`'s naming convention never actually took visual effect here.
    const { container: dataFlow } = renderCFEdge({ edgeType: "data-flow" });
    expect(dataFlow.querySelector("path[data-testid='base-edge']")).toHaveClass(
      "cf-edge-animated",
    );

    const { container: binding } = renderCFEdge({
      edgeType: "service-binding",
    });
    expect(
      binding.querySelector("path[data-testid='base-edge']"),
    ).not.toHaveClass("cf-edge-animated");
  });
});
