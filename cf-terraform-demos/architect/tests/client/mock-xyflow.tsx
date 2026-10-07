/**
 * @file A shared `@xyflow/react` stand-in for component tests. The real `<ReactFlow>` needs a
 *   provider plus browser APIs jsdom does not implement — `ResizeObserver` and genuine layout
 *   measurement — so a test that mounted it would be asserting against a canvas that measured zero
 *   by zero. These stubs render the structure a test can actually make a claim about, and surface
 *   the props whose _values_ are the behaviour under review, such as the thumbnail's focusability.
 *   What this file cannot cover is deliberate and recorded in the demo's README: geometry, fit-view
 *   behaviour and pointer interaction are reviewed in a real browser, because no DOM test in jsdom
 *   can fail on them. Usage, at the top of a test file before importing the component under test:
 *
 *   ```ts
 *   vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));
 *   ```
 */

import { createElement, Fragment, type ReactNode } from 'react';
import { vi } from 'vitest';

/**
 * Spy standing in for `useReactFlow().fitView()`.
 *
 * Exported individually rather than hidden inside the hook so a test can assert that the editor
 * fitted the view — the one piece of React Flow's imperative API whose _being called_ is this
 * application's behaviour rather than React Flow's.
 */
export const mockFitView = vi.fn().mockResolvedValue(undefined);

/**
 * Spy standing in for `useReactFlow().zoomIn()`.
 */
export const mockZoomIn = vi.fn().mockResolvedValue(undefined);

/**
 * Spy standing in for `useReactFlow().zoomOut()`.
 */
export const mockZoomOut = vi.fn().mockResolvedValue(undefined);

/**
 * Spy standing in for `useReactFlow().getZoom()`, defaulting to 100%.
 */
export const mockGetZoom = vi.fn().mockReturnValue(1);

/**
 * Spy standing in for `useReactFlow().getNodes()`, defaulting to an empty canvas.
 */
export const mockGetNodes = vi.fn().mockReturnValue([]);

/**
 * Spy standing in for `useReactFlow().screenToFlowPosition()`.
 *
 * Returns its argument unchanged: jsdom computes no layout, so there is no viewport transform to
 * reproduce, and a test asserting on a dropped node's position is asserting on the coordinates the
 * component passed in.
 */
export const mockScreenToFlowPosition = vi
  .fn()
  .mockImplementation((position: { x: number; y: number }) => position);

/**
 * Spy standing in for `getNodesBounds()`, defaulting to a landscape diagram.
 */
export const mockGetNodesBounds = vi.fn().mockReturnValue({ height: 300, width: 400, x: 0, y: 0 });

/**
 * Spy standing in for `useNodesInitialized()`.
 *
 * Defaults to `true`, since most tests are not about measurement. A test covering the editor's
 * fit-on-load behaviour sets it to `false` first, because that is the state React Flow is really in
 * at mount: `CFNode` has no intrinsic size, so no node has been measured yet.
 */
export const mockUseNodesInitialized = vi.fn().mockReturnValue(true);

/**
 * Applies `add` and `remove` node changes.
 *
 * Other change kinds are no-ops: `position` and `select` are applied by React Flow against its own
 * internal store, and the behaviour under test is which changes the application's store treats as
 * structural, not how React Flow mutates an array.
 *
 * @param changes Changes to apply.
 * @param nodes Current nodes.
 * @returns The resulting nodes.
 */
export function applyNodeChanges(changes: unknown[], nodes: unknown[]): unknown[] {
  let result = [...nodes];
  for (const change of changes as Record<string, unknown>[]) {
    if (change.type === 'add') {
      result.push(change.item);
    }
    if (change.type === 'remove') {
      result = result.filter((node) => (node as { id: string }).id !== change.id);
    }
  }
  return result;
}

/**
 * Applies `add` and `remove` edge changes; see {@link applyNodeChanges}.
 *
 * @param changes Changes to apply.
 * @param edges Current edges.
 * @returns The resulting edges.
 */
export function applyEdgeChanges(changes: unknown[], edges: unknown[]): unknown[] {
  let result = [...edges];
  for (const change of changes as Record<string, unknown>[]) {
    if (change.type === 'add') {
      result.push(change.item);
    }
    if (change.type === 'remove') {
      result = result.filter((edge) => (edge as { id: string }).id !== change.id);
    }
  }
  return result;
}

/**
 * Appends an edge, deriving an id from its endpoints as React Flow's own helper does.
 *
 * @param edge Edge to append.
 * @param edges Current edges.
 * @returns The resulting edges.
 */
export function addEdge(edge: Record<string, unknown>, edges: unknown[]): unknown[] {
  return [...edges, { id: `${edge.source as string}-${edge.target as string}`, ...edge }];
}

/**
 * Stand-in `useReactFlow()`, returning the exported spies.
 *
 * @returns The imperative canvas handle the editor's components use.
 */
export function useReactFlow() {
  return {
    fitView: mockFitView,
    getNodes: mockGetNodes,
    getZoom: mockGetZoom,
    screenToFlowPosition: mockScreenToFlowPosition,
    zoomIn: mockZoomIn,
    zoomOut: mockZoomOut
  };
}

/**
 * Stand-in `useNodesInitialized()`, delegating to {@link mockUseNodesInitialized}.
 *
 * @returns Whether every node has been measured.
 */
export function useNodesInitialized(): boolean {
  return mockUseNodesInitialized() as boolean;
}

/**
 * Stand-in for `getNodesBounds()`, delegating to {@link mockGetNodesBounds}.
 */
export const getNodesBounds = mockGetNodesBounds;

/**
 * Stand-in for React Flow's `Position` string enum.
 */
export const Position = {
  Bottom: 'bottom',
  Left: 'left',
  Right: 'right',
  Top: 'top'
};

/**
 * Stand-in for React Flow's `BackgroundVariant` string enum.
 */
export const BackgroundVariant = {
  Cross: 'cross',
  Dots: 'dots',
  Lines: 'lines'
};

/**
 * Fixed path and label position. No test asserts on the real curve geometry, which is React Flow's
 * concern rather than this application's.
 *
 * @returns A path string and the label's x and y coordinates.
 */
export function getSmoothStepPath(): [string, number, number] {
  return ['M0,0 L100,100', 50, 50];
}

/**
 * Props the `<ReactFlow>` stub reads.
 */
interface MockReactFlowProps {
  /**
   * Canvas children, typically the background.
   */
  children?: ReactNode;
  /**
   * Whether edges are focusable. Surfaced as an attribute because its value is a tested
   * accessibility decision, not an implementation detail.
   */
  edgesFocusable?: boolean;
  /**
   * Whether nodes are focusable. Surfaced for the same reason.
   */
  nodesFocusable?: boolean;
  /**
   * Nodes handed to the canvas, surfaced as a count so a test can assert a graph was parsed.
   */
  nodes?: { id: string }[];
  /**
   * Edges handed to the canvas, surfaced as a count.
   */
  edges?: { id: string }[];
  /**
   * Whether nodes can be dragged. Surfaced as an attribute so a test can assert the read-only
   * canvas disabled it.
   */
  nodesDraggable?: boolean;
  /**
   * Whether nodes can be connected. Surfaced for the same reason.
   */
  nodesConnectable?: boolean;
  /**
   * Drag-over handler, needed for a drop to be allowed to land.
   */
  onDragOver?: (event: React.DragEvent) => void;
  /**
   * Drop handler, through which the palette adds a node at a position.
   */
  onDrop?: (event: React.DragEvent) => void;
  /**
   * Node click handler. Exposed through a button below, because this stub renders no nodes.
   */
  onNodeClick?: (event: unknown, node: { id: string }) => void;
  /**
   * Edge click handler, exposed the same way.
   */
  onEdgeClick?: (event: unknown, edge: { id: string }) => void;
  /**
   * Background click handler, which clears the selection.
   */
  onPaneClick?: () => void;
}

/**
 * Minimal `<ReactFlow>` stand-in.
 *
 * `nodesFocusable` and `edgesFocusable` are exposed as `data-*` attributes rather than actually
 * gating focus, which this stub has none of: their values are the thing under test. Nothing
 * focusable may live inside an `aria-hidden` thumbnail, and React Flow defaults both to `true`
 * regardless of `elementsSelectable`, so a component that forgets to pass `false` is a real
 * accessibility defect this lets a test catch.
 *
 * The selection callbacks are surfaced as buttons rather than attributes, because a test needs to
 * _invoke_ them: this stub renders no nodes or edges to click, and React Flow's own hit testing
 * needs the layout jsdom does not compute. A button whose activation calls the handler with a fixed
 * id reproduces the one thing the application controls — what it does when a node is clicked.
 *
 * @param props Canvas props; see {@link MockReactFlowProps}.
 * @returns A placeholder element carrying the asserted props and the selection triggers.
 */
export function ReactFlow({
  children,
  edges,
  edgesFocusable,
  nodes,
  nodesConnectable,
  nodesDraggable,
  nodesFocusable,
  onDragOver,
  onDrop,
  onEdgeClick,
  onNodeClick,
  onPaneClick
}: MockReactFlowProps) {
  return createElement(
    'div',
    {
      'data-edge-count': String(edges?.length ?? 0),
      'data-edges-focusable': String(edgesFocusable),
      'data-node-count': String(nodes?.length ?? 0),
      'data-nodes-connectable': String(nodesConnectable),
      'data-nodes-draggable': String(nodesDraggable),
      'data-nodes-focusable': String(nodesFocusable),
      'data-testid': 'react-flow',
      onDragOver,
      onDrop
    },
    onNodeClick
      && createElement('button', {
        'data-testid': 'rf-node-click',
        'key': 'node-click',
        'onClick': () => onNodeClick({}, { id: 'test-node' }),
        'type': 'button'
      }),
    onEdgeClick
      && createElement('button', {
        'data-testid': 'rf-edge-click',
        'key': 'edge-click',
        'onClick': () => onEdgeClick({}, { id: 'test-edge' }),
        'type': 'button'
      }),
    onPaneClick
      && createElement('button', {
        'data-testid': 'rf-pane-click',
        'key': 'pane-click',
        'onClick': onPaneClick,
        'type': 'button'
      }),
    children
  );
}

/**
 * Minimal `<MiniMap>` stand-in.
 *
 * Calls `nodeColor` once with a fixed Workers node. The real minimap reads the canvas's nodes from
 * React Flow's internal store, which this stub does not reproduce, so a test can only exercise the
 * colour function for that one type — anything more would be asserting against this file rather
 * than the application.
 *
 * @param props Minimap props; only the colour function is read.
 * @returns A placeholder element.
 */
export function MiniMap({ nodeColor }: { nodeColor?: (node: unknown) => string }) {
  nodeColor?.({ data: { typeId: 'worker' } });
  return createElement('div', { 'data-testid': 'rf-minimap' });
}

/**
 * Minimal `<Controls>` stand-in, rendering none of React Flow's own zoom buttons.
 *
 * @returns A placeholder element.
 */
export function Controls() {
  return createElement('div', { 'data-testid': 'rf-controls' });
}

/**
 * No-op provider stand-in. The real `<ReactFlowProvider>` sets up context none of these stubs read.
 *
 * @param props Children to render unchanged.
 * @returns The children.
 */
export function ReactFlowProvider({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

/**
 * Minimal `<Background>` stand-in, rendering no visible pattern.
 *
 * @returns A placeholder element.
 */
export function Background() {
  return createElement('div', { 'data-testid': 'rf-background' });
}

/**
 * Minimal `<Handle>` stand-in, exposing its id, type and position as attributes instead of
 * rendering a real draggable connection point.
 *
 * @param props Handle identity and placement.
 * @returns A placeholder element carrying the handle's attributes.
 */
export function Handle({ id, position, type }: { id?: string; position?: string; type?: string }) {
  return createElement('div', {
    'data-handle-position': position,
    'data-handle-type': type,
    'data-testid': `handle-${id ?? 'unknown'}`
  });
}

/**
 * Minimal `<BaseEdge>` stand-in, rendering a real `<path>` so a test can read the class name and
 * inline style the edge component computed.
 *
 * @param props Edge path and presentation.
 * @returns A `<path>` carrying the computed styling.
 */
export function BaseEdge({
  className,
  markerEnd,
  path,
  style
}: {
  className?: string;
  markerEnd?: string;
  path?: string;
  style?: React.CSSProperties;
}) {
  return createElement('path', {
    className,
    'd': path,
    'data-marker-end': markerEnd ?? '',
    'data-testid': 'base-edge',
    style
  });
}

/**
 * Minimal `<EdgeLabelRenderer>` stand-in, rendering children in place rather than portalling them
 * into a separate overlay layer.
 *
 * @param props Children to render.
 * @returns A placeholder wrapper around the children.
 */
export function EdgeLabelRenderer({ children }: { children?: ReactNode }) {
  return createElement('div', { 'data-testid': 'edge-label-renderer' }, children);
}
