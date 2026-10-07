/**
 * @file The `data` payloads attached to every React Flow node and edge on the canvas. These are the
 *   client's vocabulary, not the server's. The Worker validates that a node is an object with a
 *   non-empty string `id` and stores the rest verbatim (`../../../worker/domain/ graph.ts`), so a
 *   field added here needs no server change — which is the whole reason that validation is
 *   shallow.
 */

/**
 * Data payload for a Cloudflare service node on the canvas.
 */
export interface CFNodeData {
  /**
   * Catalogue type identifier, for example `'worker'` or `'d1'`. Resolved through
   * `../../../catalog.ts`'s `NODE_TYPE_MAP` for the node's icon, category colour and handles.
   */
  typeId: string;
  /**
   * User-editable display label shown on the canvas. Defaults to the catalogue label.
   */
  label: string;
  /**
   * Optional free-text annotation shown below the label.
   */
  description?: string;
  /**
   * Visual style overrides.
   */
  style?: {
    /**
     * Overrides the node's default category border and handle colour.
     */
    accentColor?: string;
  };
  /**
   * Index signature required by React Flow's generic `Node<T>` constraint.
   */
  [key: string]: unknown;
}

/**
 * Data payload for a connection edge between two nodes.
 */
export interface CFEdgeData {
  /**
   * Visual and semantic type controlling stroke style, animation and arrowheads.
   */
  edgeType: 'data-flow' | 'service-binding' | 'trigger' | 'external';
  /**
   * Optional label rendered at the edge midpoint.
   */
  label?: string;
  /**
   * Optional tooltip annotation.
   */
  description?: string;
  /**
   * Communication protocol hint, for example `'http'`, `'ws'` or `'binding'`.
   */
  protocol?: string;
  /**
   * Index signature required by React Flow's generic `Edge<T>` constraint.
   */
  [key: string]: unknown;
}
