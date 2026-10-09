/**
 * @file The shared vocabulary for which face of a node an edge attaches to. It lives in `src/`
 *   rather than under `src/client/` or `src/worker/` for the same reason `./graph-element-types.ts`
 *   does: both sides need it and neither owns it. The editor's **Connect nodes** dialog decides the
 *   pair when it creates an edge (`./client/components/editor/connect.ts`), and the server-side SVG
 *   export reads the pair back off the stored edge to anchor its path
 *   (`./worker/domain/graph-svg.ts`). Only that dialog ever records handle ids. A blueprint
 *   template and every MCP graph mutation (`./worker/domain/graph-mutations.ts`) omit them, and
 *   React Flow then attaches the edge to each node's _first_ declared handle of the needed kind —
 *   which `./catalog.ts` orders `target-top` before `target-left` and `source-bottom` before
 *   `source-right`. A handle-less edge therefore runs bottom-to-top however the two boxes sit
 *   relative to one another. That last fact is what the export originally got wrong. It derived the
 *   side from the boxes' own geometry, so an agent adding a node down and to the right produced a
 *   file whose edge left the source's right face while the canvas drew it leaving the bottom — and
 *   because the export is the artefact that ends up in a document, where nobody can hold it against
 *   the canvas, the arrow appeared to come from whichever unrelated node it happened to pass
 *   behind.
 */

/**
 * A point on the canvas. Structural rather than React Flow's `XYPosition`, so the Worker can use
 * this module without taking a dependency on a client-only package.
 */
export interface Point {
  /**
   * Horizontal canvas coordinate; larger is further right.
   */
  x: number;
  /**
   * Vertical canvas coordinate; larger is further down.
   */
  y: number;
}

/**
 * The pair of catalogue handle ids that means "draw this edge sideways".
 *
 * Exported as a constant rather than spelled out at each use so the renderer's test for a
 * horizontal edge and the dialog's preference for one cannot disagree about the spelling.
 */
export const HORIZONTAL_HANDLES = {
  source: 'source-right',
  target: 'target-left'
} as const;

/**
 * The pair meaning "draw this edge top to bottom", which is also React Flow's own fallback when an
 * edge records no handles at all.
 */
export const VERTICAL_HANDLES = {
  source: 'source-bottom',
  target: 'target-top'
} as const;

/**
 * The pair of catalogue handle ids an edge between two nodes should prefer.
 */
export interface PreferredHandles {
  /**
   * Handle id on the node the edge leaves.
   */
  source: 'source-bottom' | 'source-right';
  /**
   * Handle id on the node the edge reaches.
   */
  target: 'target-left' | 'target-top';
}

/**
 * Chooses which pair of handles a newly created edge between two node positions should prefer.
 *
 * The comparison is between the two nodes' origins. Every node on the canvas is the same width, so
 * the origins already differ by exactly the quantity that matters, and comparing centres instead
 * would fold in a half-width term that can tip a relationship the rest of the editor treats as
 * vertical over into a horizontal one.
 *
 * `>=` resolves an exactly diagonal relationship to horizontal, and `dx > 0` keeps anything to the
 * left vertical: the catalogue declares a source handle only on a node's bottom or right, so there
 * is no leftward handle to prefer in the first place.
 *
 * This returns a _preference_. A node type is free not to declare the handle named here, and the
 * caller falls back — see `resolveHandle` in `./client/components/editor/connect.ts`.
 *
 * @param source Canvas position of the node the edge leaves.
 * @param target Canvas position of the node the edge reaches.
 * @returns The preferred source and target handle ids.
 */
export function preferredHandles(source: Point, target: Point): PreferredHandles {
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  return Math.abs(dx) >= Math.abs(dy) && dx > 0 ? HORIZONTAL_HANDLES : VERTICAL_HANDLES;
}
