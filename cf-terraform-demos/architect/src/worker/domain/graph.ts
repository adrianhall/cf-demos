import { badRequest, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';

/**
 * @file Graph shape validation and canonicalisation. Pure: no binding, no fetch, no storage, so
 *   every transport that can replace a diagram's graph — the editor's autosave today, an MCP tool
 *   in a later phase — enforces the identical rules rather than each re-deriving them. The
 *   validation is deliberately shallow. A node must be an object with a non-empty string `id`, and
 *   nothing else about it is inspected: `type`, `position` and `data` are the editor's vocabulary,
 *   not the server's, and a server that validated them would have to be redeployed before the
 *   client could add a field. The `id` is the exception because it is the one property the server
 *   itself relies on — a later phase's granular operations address a node by it, and an element
 *   with no stable identity cannot be the target of one.
 */

/**
 * Viewport written when a graph arrives without one.
 *
 * Frozen rather than a plain literal: it is shared by every defaulted graph, and a caller mutating
 * the object it was handed would change the default for every subsequent save in the same isolate.
 */
const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 1 });

/**
 * Parsed, canonical shape of a diagram's `graphData`: a React Flow node/edge/viewport graph.
 *
 * Nodes and edges are `Record<string, unknown>` rather than typed React Flow elements because the
 * Worker genuinely does not know their shape and must not pretend to — see the file comment above.
 */
export interface GraphData {
  /**
   * React Flow nodes, each an arbitrary JSON object carrying at least a non-empty string `id`.
   */
  nodes: Record<string, unknown>[];
  /**
   * React Flow edges, each an arbitrary JSON object carrying at least a non-empty string `id`.
   */
  edges: Record<string, unknown>[];
  /**
   * Canvas pan and zoom state.
   */
  viewport: { x: number; y: number; zoom: number };
}

/**
 * Reports whether a value is a plain JSON object.
 *
 * Arrays and `null` are excluded explicitly: both are `typeof 'object'`, so a naive check would let
 * `[]` or `null` reach property access and produce a confusing error about a missing field rather
 * than a clear one about the value's shape.
 *
 * @param value Candidate value.
 * @returns `true` when the value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an array of React Flow nodes or edges.
 *
 * @param value Candidate array from the decoded graph.
 * @param label Field name used in the error detail, so a caller is told which array was wrong.
 * @returns The validated elements, unchanged.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not an array, or
 *   when any element is not an object carrying a non-empty string `id`. The detail names the
 *   offending index, because a client sending a 200-node graph needs to know which element to fix.
 */
function validateGraphElements(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw unprocessableContent({ detail: `graphData.${label} must be an array.` });
  }

  return value.map((element, index) => {
    if (!isPlainObject(element) || typeof element.id !== 'string' || element.id.length === 0) {
      throw unprocessableContent({
        detail: `graphData.${label}[${index}] must be an object with a non-empty string id.`
      });
    }
    return element;
  });
}

/**
 * Validates a parsed graph and re-serialises it in canonical form.
 *
 * Canonical here means only that `viewport` is always present, defaulted when the caller omitted
 * it, so every stored row has one uniform shape for a future reader to rely on. Nodes and edges
 * pass through exactly as sent.
 *
 * Exported separately from {@link validateGraphDataInput} because a later phase's auto-layout path
 * already holds a parsed graph in memory and needs the same guarantees without a redundant
 * serialise-then-parse round trip.
 *
 * @param parsed A parsed graph value, from a JSON string or assembled in memory.
 * @returns A canonical JSON string safe to persist verbatim.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is not an object, or
 *   when its nodes, edges or viewport fail shape validation.
 */
export function canonicalizeGraphData(parsed: unknown): string {
  if (!isPlainObject(parsed)) {
    throw unprocessableContent({ detail: 'graphData must decode to a JSON object.' });
  }

  const nodes = validateGraphElements(parsed.nodes ?? [], 'nodes');
  const edges = validateGraphElements(parsed.edges ?? [], 'edges');

  const rawViewport = parsed.viewport;
  let viewport: GraphData['viewport'] = DEFAULT_VIEWPORT;
  if (rawViewport !== undefined) {
    if (
      !isPlainObject(rawViewport)
      || typeof rawViewport.x !== 'number'
      || typeof rawViewport.y !== 'number'
      || typeof rawViewport.zoom !== 'number'
    ) {
      throw unprocessableContent({
        detail: 'graphData.viewport must be { x, y, zoom } numbers.'
      });
    }
    viewport = { x: rawViewport.x, y: rawViewport.y, zoom: rawViewport.zoom };
  }

  const canonical: GraphData = { nodes, edges, viewport };
  return JSON.stringify(canonical);
}

/**
 * Validates the `graphData` field of a graph-save request body.
 *
 * The client always sends the entire graph on every save — there is no partial-patch protocol — so
 * this fully replaces the stored value rather than merging into it. The field is a JSON _string_
 * rather than a nested object because that is exactly how it is stored and how the client holds it;
 * re-encoding it at the transport boundary would mean the bytes persisted were never the bytes
 * validated.
 *
 * @param value Parsed JSON request body, expected to be `{ graphData: '<json string>' }`.
 * @returns A canonical JSON string safe to persist.
 * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object, and
 *   `unprocessableContent()` (422) when `graphData` is absent, is not a string, does not contain
 *   valid JSON, or decodes to a graph that fails shape validation.
 */
export function validateGraphDataInput(value: unknown): string {
  if (!isPlainObject(value)) {
    throw badRequest({ detail: 'The request body must be an object.' });
  }

  const raw = Reflect.get(value, 'graphData');
  if (typeof raw !== 'string') {
    throw unprocessableContent({ detail: 'graphData must be a JSON string.' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unprocessableContent({ detail: 'graphData must contain valid JSON.' });
  }

  return canonicalizeGraphData(parsed);
}

/**
 * An empty React Flow graph, used to seed a diagram created without a blueprint.
 *
 * Built through {@link canonicalizeGraphData} rather than written as a literal, so the blank canvas
 * a user starts from is byte-identical to what a save of that same empty canvas would produce. A
 * hand-written literal here would be a second definition of "canonical" that could silently diverge
 * from the one every write goes through.
 */
export const EMPTY_GRAPH_DATA = canonicalizeGraphData({});
