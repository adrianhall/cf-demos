/**
 * @file Shared React Flow type-key constants for the two element kinds this demo's canvas renders.
 *   `"cf-node"` and `"cf-edge"` are the `type` values every node and edge in D1's `graph_data`
 *   column carries. The client's React Flow `nodeTypes`/`edgeTypes` registries key off them to
 *   choose a renderer, and every graph constructor — the blueprint templates today, the editor's
 *   store and the MCP graph mutations in later phases — stamps them onto whatever it builds. They
 *   live in `src/` rather than under `src/client/` or `src/worker/` because both sides need them
 *   and neither owns them: a constant re-typed independently on each side is a literal that can
 *   drift, and the symptom would be a node that persists correctly and then renders as React Flow's
 *   unstyled default.
 */

/**
 * React Flow `type` value for every Cloudflare service node on the canvas.
 */
export const CF_NODE_TYPE = 'cf-node';

/**
 * React Flow `type` value for every connection edge on the canvas.
 */
export const CF_EDGE_TYPE = 'cf-edge';
