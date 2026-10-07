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
 * @param props Canvas props; see {@link MockReactFlowProps}.
 * @returns A placeholder element carrying the asserted props.
 */
export function ReactFlow({
  children,
  edges,
  edgesFocusable,
  nodes,
  nodesFocusable
}: MockReactFlowProps) {
  return createElement(
    'div',
    {
      'data-edge-count': String(edges?.length ?? 0),
      'data-edges-focusable': String(edgesFocusable),
      'data-node-count': String(nodes?.length ?? 0),
      'data-nodes-focusable': String(nodesFocusable),
      'data-testid': 'react-flow'
    },
    children
  );
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
