/**
 * @file The diagram's own domain types. Pure data shapes with no binding, fetch or transport
 *   dependency, so the HTTP API today and the MCP tool layer in a later phase describe the same
 *   diagram rather than two near-identical ones. `graphData` is deliberately an opaque JSON string
 *   at this boundary rather than a parsed object. Nothing in the Worker reads inside a node or an
 *   edge: the server validates the graph's shape on write (`./graph.ts`) and otherwise stores and
 *   returns exactly what the editor sent. Keeping it a string makes that restraint visible, and
 *   keeps a storage round-trip free of a parse/serialise pair that could silently reorder or drop a
 *   field the client depends on.
 */

/**
 * A diagram as the application tier sees it, including its owner.
 *
 * The owner travels with the diagram because authorization is an application decision: a service
 * reads the diagram, compares `ownerEmail` with the verified actor, and answers `404` when they
 * differ. That is why the repository port is authorization-neutral — see
 * `../application/ports/diagram-repository.ts`.
 */
export interface Diagram {
  /**
   * Server-generated UUID, immutable for the diagram's lifetime.
   */
  id: string;
  /**
   * Verified Cloudflare Access identity that owns this diagram. Never supplied by a client.
   */
  ownerEmail: string;
  /**
   * User-editable title, defaulted to {@link DEFAULT_DIAGRAM_TITLE} when omitted at creation.
   */
  title: string;
  /**
   * Optional free-text description. `null` when never set or explicitly cleared.
   */
  description: string | null;
  /**
   * Canonicalised JSON-serialised React Flow state: `{ nodes, edges, viewport }`.
   */
  graphData: string;
  /**
   * ISO-8601 creation timestamp.
   */
  createdAt: string;
  /**
   * ISO-8601 timestamp of the most recent metadata or graph update.
   */
  updatedAt: string;
}

/**
 * Fields accepted when creating a diagram.
 */
export interface CreateDiagramInput {
  /**
   * Diagram title. Defaults to {@link DEFAULT_DIAGRAM_TITLE} when omitted.
   */
  title?: string;
  /**
   * Optional free-text description.
   */
  description?: string | null;
  /**
   * Slug of a blueprint template (`../../blueprints.ts`) whose `graphData` seeds the new diagram.
   *
   * Resolved server-side against `BLUEPRINT_MAP` by the application service. A client names a
   * template; it never supplies the graph itself at creation time, so a caller cannot use creation
   * to store graph content that skipped validation.
   */
  blueprintId?: string;
}

/**
 * Fields accepted when updating a diagram's metadata.
 *
 * An omitted property leaves the stored value unchanged, which is distinct from `description: null`
 * — that explicitly clears it. The validator preserves the distinction rather than collapsing both
 * to "no description".
 */
export interface UpdateDiagramInput {
  /**
   * New title.
   */
  title?: string;
  /**
   * New description. `null` clears it; omitting the property leaves it unchanged.
   */
  description?: string | null;
}

/**
 * A diagram as somebody who is not its owner may see it.
 *
 * `ownerEmail` is absent **by construction** rather than stripped on the way out, and that is the
 * whole of this type's job. Two surfaces return it — the anonymous share resolver (`./share.ts`'s
 * {@link SharedDiagram}) and the administrative moderation preview
 * (`../application/admin-service.ts`) — and in both cases disclosing the owner would be the
 * mistake. A type that _could_ carry the owner would make omitting it a thing to remember; the
 * adapter selects exactly these columns, so the owner is never read from storage at all.
 */
export interface PublicDiagram {
  /**
   * Diagram id, used by the client to key the read-only canvas.
   */
  id: string;
  /**
   * Diagram title.
   */
  title: string;
  /**
   * Diagram description, or `null`.
   */
  description: string | null;
  /**
   * The diagram's current graph, JSON-serialised.
   */
  graphData: string;
}

/**
 * Title assigned when a create request omits one.
 *
 * A constant rather than an empty string: the dashboard card and the editor's title control both
 * need something to render, and a diagram with a blank name is indistinguishable from every other
 * blank-named diagram in the list.
 */
export const DEFAULT_DIAGRAM_TITLE = 'Untitled Diagram';
