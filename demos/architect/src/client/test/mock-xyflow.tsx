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
/** Stand-in for `useNodesInitialized()`; defaults to `true` since most tests render with nodes
 * that don't need real DOM measurement. Reset to `false` in a test to exercise the
 * measurement-pending branch of `../components/editor/DiagramCanvas.tsx`'s fit-on-load effect
 * (Bug 29, docs/09-ARCHITECT.md Phase 9). */
export const mockUseNodesInitialized = vi.fn().mockReturnValue(true);

/** Enum stand-in matching `@xyflow/react`'s real `Position` string enum. */
export const Position = {
  Bottom: "bottom",
  Left: "left",
  Right: "right",
  Top: "top",
};
/** Enum stand-in matching `@xyflow/react`'s real `BackgroundVariant` string enum. */
export const BackgroundVariant = {
  Cross: "cross",
  Dots: "dots",
  Lines: "lines",
};

/** Applies `"add"`/`"remove"` node changes; other change types (e.g. `"position"`, `"select"`)
 * are no-ops, matching what `../stores/diagramStore.ts`'s tests actually exercise. */
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

/** Applies `"add"`/`"remove"` edge changes; other change types (e.g. `"select"`) are no-ops. */
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

/** Appends a new edge with an id derived from its source/target, matching `@xyflow/react`'s
 * real `addEdge` shape closely enough for `../stores/diagramStore.ts`'s `onConnect` tests. */
export function addEdge(edge: Record<string, unknown>, edges: unknown[]) {
  return [
    ...edges,
    { id: `${edge.source as string}-${edge.target as string}`, ...edge },
  ];
}

/** Fixed stand-in path/label-position tuple; no test asserts on the actual path geometry. */
export function getSmoothStepPath(): [string, number, number] {
  return ["M0,0 L100,100", 50, 50];
}

/** Stand-in `useReactFlow()` returning the shared `mock*` spies above, so tests can assert on
 * calls to `fitView`/`getNodes`/`screenToFlowPosition`/`zoomIn`/`zoomOut` directly. */
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

/** Stand-in `useNodesInitialized()` delegating to {@link mockUseNodesInitialized}. */
export function useNodesInitialized() {
  return mockUseNodesInitialized();
}

export const getNodesBounds = mockGetNodesBounds;
export const getViewportForBounds = mockGetViewportForBounds;

/** Minimal `<ReactFlow>` stand-in exposing the callbacks tests need to invoke.
 *
 * `nodesFocusable`/`edgesFocusable` are surfaced as `data-nodes-focusable`/`data-edges-focusable`
 * string attributes (rather than actually gating any focus behavior, which this stub has none
 * of) purely so a test can assert which value a caller passed -- see
 * `../components/blueprints/BlueprintPreview.test.tsx` (Bug 33, docs/09-ARCHITECT.md Phase 10).
 */
export function ReactFlow({
  children,
  edgesFocusable,
  nodesFocusable,
  onDragOver,
  onDrop,
  onEdgeClick,
  onNodeClick,
  onPaneClick,
}: {
  children?: React.ReactNode;
  edgesFocusable?: boolean;
  nodesFocusable?: boolean;
  onDragOver?: (event: React.DragEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  onEdgeClick?: (event: unknown, edge: { id: string }) => void;
  onNodeClick?: (event: unknown, node: { id: string }) => void;
  onPaneClick?: () => void;
}) {
  return createElement(
    "div",
    {
      "data-edges-focusable": String(edgesFocusable),
      "data-nodes-focusable": String(nodesFocusable),
      "data-testid": "react-flow",
      onDragOver,
      onDrop,
    },
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

/** No-op provider stand-in; the real `<ReactFlowProvider>` sets up context this mock's
 * components never read. */
export function ReactFlowProvider({
  children,
}: {
  children?: React.ReactNode;
}) {
  return createElement(Fragment, null, children);
}

/** Minimal `<Background>` stand-in; renders no visible pattern. */
export function Background() {
  return createElement("div", { "data-testid": "rf-background" });
}

/**
 * Minimal `<MiniMap>` stand-in. Always invokes `nodeColor` with a single hardcoded
 * `{ data: { typeId: "worker" } }` node rather than the diagram's real current nodes, since the
 * real `<MiniMap>` reads nodes from `@xyflow/react`'s internal store context, which this mock
 * does not reproduce. This means a test cannot exercise `nodeColor`'s behavior for any node
 * type other than `"worker"` (for example, an unrecognized/legacy `typeId`'s category-color
 * fallback) without this mock being extended to accept and forward real node data.
 */
export function MiniMap({
  nodeColor,
}: {
  nodeColor?: (node: unknown) => string;
}) {
  nodeColor?.({ data: { typeId: "worker" } });
  return createElement("div", { "data-testid": "rf-minimap" });
}

/** Minimal `<Controls>` stand-in; renders no interactive zoom/fit buttons. */
export function Controls() {
  return createElement("div", { "data-testid": "rf-controls" });
}

/** Minimal `<Handle>` stand-in exposing its position/type as `data-*` attributes and its id as
 * `handle-${id}` for `getByTestId` lookups, instead of rendering a real draggable connection
 * point. */
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

/** Minimal `<BaseEdge>` stand-in rendering a real `<path>` with the given `path`/`style`/
 * `className`, so `CFEdge.tsx` tests can assert on the computed stroke path and styling. */
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

/** Minimal `<EdgeLabelRenderer>` stand-in; renders children directly rather than portalling
 * them into a separate overlay layer as the real implementation does. */
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
