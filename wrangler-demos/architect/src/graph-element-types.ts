/**
 * Shared React Flow type-key constants for the two element kinds this demo's canvas renders.
 * `"cf-node"` and `"cf-edge"` are the `type` values every diagram node/edge in D1's `graph_data`
 * column carries -- the React Flow `nodeTypes`/`edgeTypes` registries
 * (`./client/components/editor/nodes/nodeTypes.ts`, `./client/components/editor/edges/edgeTypes.ts`)
 * key off of them to choose a renderer, and the shared graph-mutation service
 * (`./graph-mutations.ts`) stamps them onto every node/edge it constructs, whether from a human
 * WebSocket edit, a remote MCP tool call, or another client's own broadcast operation applied
 * locally (docs/09C-COLLABORATIVE-EDITING.md's Live-Editing Architecture). Every side imports the
 * same constant from here rather than re-typing the literal independently, so the client renderer
 * registry and every graph constructor can never silently drift.
 */

/** React Flow `type` value for every Cloudflare service node on the canvas. */
export const CF_NODE_TYPE = "cf-node";

/** React Flow `type` value for every connection edge on the canvas. */
export const CF_EDGE_TYPE = "cf-edge";
