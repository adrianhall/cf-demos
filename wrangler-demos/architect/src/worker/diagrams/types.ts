/**
 * A diagram row as stored in D1's `diagrams` table (docs/09-ARCHITECT.md's Data Model).
 * `graphData` is an opaque, canonicalized JSON string -- see {@link GraphData} -- the Worker
 * never inspects individual nodes/edges beyond validating that shape on write.
 */
export interface Diagram {
  /** Server-generated UUID, immutable for the diagram's lifetime. */
  id: string;
  /** Verified Cloudflare Access identity that owns this diagram. */
  ownerEmail: string;
  /** User-editable title, defaulted to "Untitled Diagram" when omitted at creation. */
  title: string;
  /** Optional free-text description, `null` when never set. */
  description: string | null;
  /** Canonicalized JSON-serialised React Flow state: `{ nodes, edges, viewport }`. */
  graphData: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent metadata or graph update. */
  updatedAt: string;
}

/** Fields accepted when creating a new diagram (`POST /api/diagrams`). */
export interface CreateDiagramInput {
  /** Diagram title. Defaults to "Untitled Diagram" when omitted. */
  title?: string;
  /** Optional free-text description. */
  description?: string | null;
  /**
   * Slug of a blueprint template (`../../blueprints.ts`) whose `graphData` seeds the new
   * diagram. Resolved server-side against `BLUEPRINT_MAP`, never trusted from a client-supplied
   * `graphData` payload -- see `../routes/diagrams.ts`.
   */
  blueprintId?: string;
}

/** Fields accepted when updating a diagram's metadata (`PATCH /api/diagrams/:id`). */
export interface UpdateDiagramInput {
  /** New title. */
  title?: string;
  /** New description. `null` clears it; omitted leaves it unchanged. */
  description?: string | null;
}

/**
 * Parsed, canonical shape of a diagram's `graphData` column: a React Flow node/edge/viewport
 * graph. The Worker validates this shape on every autosave (`PUT /api/diagrams/:id/graph`) but
 * never inspects individual node/edge `data` payloads -- those are opaque to the server and
 * meaningful only to the `@xyflow/react` client (`src/client/components/editor/types.ts`).
 */
export interface GraphData {
  /** React Flow nodes, each an arbitrary JSON object with at least a string `id`. */
  nodes: Record<string, unknown>[];
  /** React Flow edges, each an arbitrary JSON object with at least a string `id`. */
  edges: Record<string, unknown>[];
  /** Canvas pan/zoom state. */
  viewport: { x: number; y: number; zoom: number };
}
