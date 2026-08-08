/**
 * Shared data interfaces for React Flow nodes and edges on the canvas.
 *
 * These types define the `data` payload attached to each React Flow `Node`/`Edge`. They are
 * used by the Zustand store (`../../stores/diagramStore.ts`), the custom node/edge renderers,
 * and the properties panel.
 */

/** Data payload for a Cloudflare service node on the canvas. */
export interface CFNodeData {
  /** Catalog type identifier (e.g. "worker", "d1"). Links to `../../../catalog.ts`. */
  typeId: string;
  /** User-editable display label shown on the canvas. Defaults to the catalog label. */
  label: string;
  /** Optional free-text annotation shown below the label. */
  description?: string;
  /** Visual style overrides. */
  style?: {
    /** Override the default category border/handle colour. */
    accentColor?: string;
  };
  /** Index signature required by React Flow's generic `Node<T>` constraint. */
  [key: string]: unknown;
}

/** Data payload for a connection edge between two nodes on the canvas. */
export interface CFEdgeData {
  /** Visual/semantic type controlling stroke style, animation, and arrowheads. */
  edgeType: "data-flow" | "service-binding" | "trigger" | "external";
  /** Optional label rendered at the edge midpoint. */
  label?: string;
  /** Optional tooltip annotation. */
  description?: string;
  /** Communication protocol hint (e.g. "http", "ws", "binding"). */
  protocol?: string;
  /** Index signature required by React Flow's generic `Edge<T>` constraint. */
  [key: string]: unknown;
}
