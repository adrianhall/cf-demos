/**
 * Shared `@xyflow/react` mock for component tests.
 *
 * `@xyflow/react`'s real `<ReactFlow>`/`<Handle>`/`<BaseEdge>` components need a
 * `ReactFlowProvider` and browser APIs jsdom does not implement (`ResizeObserver`, real layout
 * measurement). Every editor component test mocks the whole module with this file's stub
 * components instead of reaching for a heavier real-DOM test tool, matching this repository's
 * "no Playwright/real-browser tool" Vitest-only testing convention -- and mirrors the same
 * pattern CF-Architect's own component tests already used (`tests/helpers/mock-xyflow.ts`).
 *
 * Usage: `vi.mock("@xyflow/react", () => import("../../test/mock-xyflow"))` (path relative to
 * the test file) at the top of a test file, before importing the component under test.
 */
import { createElement, Fragment } from "react";
import { vi } from "vitest";

export const mockFitView = vi.fn().mockResolvedValue(undefined);
export const mockZoomIn = vi.fn().mockResolvedValue(undefined);
export const mockZoomOut = vi.fn().mockResolvedValue(undefined);
export const mockGetZoom = vi.fn().mockReturnValue(1);
export const mockGetNodes = vi.fn().mockReturnValue([]);
export const mockScreenToFlowPosition = vi
  .fn()
  .mockImplementation((position: { x: number; y: number }) => position);
export const mockGetNodesBounds = vi
  .fn()
  .mockReturnValue({ height: 300, width: 400, x: 0, y: 0 });
export const mockGetViewportForBounds = vi
  .fn()
  .mockReturnValue({ x: 0, y: 0, zoom: 1 });

/** Enum stand-ins matching `@xyflow/react`'s real string-valued enums. */
export const Position = {
  Bottom: "bottom",
  Left: "left",
  Right: "right",
  Top: "top",
};
export const BackgroundVariant = {
  Cross: "cross",
  Dots: "dots",
  Lines: "lines",
};

/** Renders every node/edge change helper `../stores/diagramStore.ts` depends on. */
export function applyNodeChanges(changes: unknown[], nodes: unknown[]) {
  let result = [...nodes];
  for (const change of changes as Record<string, unknown>[]) {
    if (change.type === "add") result.push(change.item);
    if (change.type === "remove") {
      result = result.filter(
        (node) => (node as { id: string }).id !== change.id,
      );
    }
  }
  return result;
}

export function applyEdgeChanges(changes: unknown[], edges: unknown[]) {
  let result = [...edges];
  for (const change of changes as Record<string, unknown>[]) {
    if (change.type === "add") result.push(change.item);
    if (change.type === "remove") {
      result = result.filter(
        (edge) => (edge as { id: string }).id !== change.id,
      );
    }
  }
  return result;
}

export function addEdge(edge: Record<string, unknown>, edges: unknown[]) {
  return [
    ...edges,
    { id: `${edge.source as string}-${edge.target as string}`, ...edge },
  ];
}

export function getSmoothStepPath(): [string, number, number] {
  return ["M0,0 L100,100", 50, 50];
}

export function useReactFlow() {
  return {
    fitView: mockFitView,
    getNodes: mockGetNodes,
    getZoom: mockGetZoom,
    screenToFlowPosition: mockScreenToFlowPosition,
    zoomIn: mockZoomIn,
    zoomOut: mockZoomOut,
  };
}

export const getNodesBounds = mockGetNodesBounds;
export const getViewportForBounds = mockGetViewportForBounds;

/** Minimal `<ReactFlow>` stand-in exposing the callbacks tests need to invoke. */
export function ReactFlow({
  children,
  onDragOver,
  onDrop,
  onEdgeClick,
  onNodeClick,
  onPaneClick,
}: {
  children?: React.ReactNode;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  onEdgeClick?: (event: unknown, edge: { id: string }) => void;
  onNodeClick?: (event: unknown, node: { id: string }) => void;
  onPaneClick?: () => void;
}) {
  return createElement(
    "div",
    { "data-testid": "react-flow", onDragOver, onDrop },
    onNodeClick &&
      createElement("button", {
        "data-testid": "rf-node-click",
        onClick: () => onNodeClick({}, { id: "test-node" }),
        type: "button",
      }),
    onEdgeClick &&
      createElement("button", {
        "data-testid": "rf-edge-click",
        onClick: () => onEdgeClick({}, { id: "test-edge" }),
        type: "button",
      }),
    onPaneClick &&
      createElement("button", {
        "data-testid": "rf-pane-click",
        onClick: onPaneClick,
        type: "button",
      }),
    children,
  );
}

export function ReactFlowProvider({
  children,
}: {
  children?: React.ReactNode;
}) {
  return createElement(Fragment, null, children);
}

export function Background() {
  return createElement("div", { "data-testid": "rf-background" });
}

export function MiniMap({
  nodeColor,
}: {
  nodeColor?: (node: unknown) => string;
}) {
  nodeColor?.({ data: { typeId: "worker" } });
  return createElement("div", { "data-testid": "rf-minimap" });
}

export function Controls() {
  return createElement("div", { "data-testid": "rf-controls" });
}

export function Handle({
  id,
  position,
  type,
}: {
  id?: string;
  position?: string;
  type?: string;
}) {
  return createElement("div", {
    "data-handle-position": position,
    "data-handle-type": type,
    "data-testid": `handle-${id ?? "unknown"}`,
  });
}

export function BaseEdge({
  className,
  markerEnd,
  path,
  style,
}: {
  className?: string;
  markerEnd?: string;
  path?: string;
  style?: React.CSSProperties;
}) {
  return createElement("path", {
    className,
    "data-marker-end": markerEnd ?? "",
    "data-testid": "base-edge",
    d: path,
    style,
  });
}

export function EdgeLabelRenderer({
  children,
}: {
  children?: React.ReactNode;
}) {
  return createElement(
    "div",
    { "data-testid": "edge-label-renderer" },
    children,
  );
}
