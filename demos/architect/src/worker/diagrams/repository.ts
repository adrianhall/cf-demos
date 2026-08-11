import type { SharedDiagram } from "../shares/types";
import type { CreateDiagramInput, Diagram, UpdateDiagramInput } from "./types";

/** Raw snake-cased diagram row returned by D1. */
interface DiagramRow {
  id: string;
  owner_email: string;
  title: string;
  description: string | null;
  graph_data: string;
  created_at: string;
  updated_at: string;
}

/** Convert D1's storage shape into the API representation. */
function toDiagram(row: DiagramRow): Diagram {
  return {
    createdAt: row.created_at,
    description: row.description,
    graphData: row.graph_data,
    id: row.id,
    ownerEmail: row.owner_email,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

/** An empty React Flow graph, used to seed a diagram with no blueprint. */
const EMPTY_GRAPH_DATA = JSON.stringify({
  edges: [],
  nodes: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

/** Default title assigned when a create request omits one. */
const DEFAULT_TITLE = "Untitled Diagram";

/**
 * D1 persistence boundary for the `diagrams` table (docs/09-ARCHITECT.md's Data Model). Every
 * read/write that could touch another identity's diagram scopes by `owner_email` in the same
 * query -- mirroring `demos/agentic-ai-chat`'s `ChatRepository.findOwned()` -- so a diagram id
 * that exists but belongs to a different owner is indistinguishable from one that does not
 * exist at all.
 */
export class DiagramRepository {
  /** @param database D1 capability used to prepare the repository's statements. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Create a new diagram owned by `ownerEmail`.
   *
   * @param ownerEmail Verified Cloudflare Access identity creating the diagram.
   * @param input Validated create input. `graphData`, when provided, is the caller's
   * already-resolved blueprint graph (`../routes/diagrams.ts` resolves `blueprintId` against
   * `../../blueprints.ts`'s `BLUEPRINT_MAP` before calling this method) -- this repository never
   * looks up blueprints itself.
   * @returns The newly persisted diagram.
   */
  async create(
    ownerEmail: string,
    input: CreateDiagramInput & { graphData?: string },
  ): Promise<Diagram> {
    const now = new Date().toISOString();
    const diagram: Diagram = {
      createdAt: now,
      description: input.description ?? null,
      graphData: input.graphData ?? EMPTY_GRAPH_DATA,
      id: crypto.randomUUID(),
      ownerEmail,
      title: input.title ?? DEFAULT_TITLE,
      updatedAt: now,
    };
    await this.database
      .prepare(
        `INSERT INTO diagrams (id, owner_email, title, description, graph_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        diagram.id,
        diagram.ownerEmail,
        diagram.title,
        diagram.description,
        diagram.graphData,
        diagram.createdAt,
        diagram.updatedAt,
      )
      .run();
    return diagram;
  }

  /**
   * Look up a diagram, scoped to its owner in the same query.
   *
   * @param id Diagram id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The diagram if it exists and is owned by `ownerEmail`, otherwise `null`.
   */
  async findOwned(id: string, ownerEmail: string): Promise<Diagram | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, title, description, graph_data, created_at, updated_at
         FROM diagrams WHERE id = ? AND owner_email = ? LIMIT 1`,
      )
      .bind(id, ownerEmail)
      .first<DiagramRow>();
    return row === null ? null : toDiagram(row);
  }

  /**
   * Load a diagram this identity may read or edit -- either because it owns it, or because it
   * has been granted collaborator access (`../collaborators/repository.ts`). Returns the
   * diagram plus the caller's `role` so route handlers can gate owner-only actions (rename,
   * delete, manage the anonymous share link, manage collaborators) without a second query --
   * see docs/09C-COLLABORATIVE-EDITING.md's Access Model.
   *
   * Implemented as a single query joining `diagrams` against `diagram_collaborators` (rather
   * than calling `../collaborators/repository.ts`'s `CollaboratorRepository.isCollaborator()`
   * separately) so a collaborator-in-name-only row pointing at a diagram that no longer exists
   * correctly resolves to `null` in one round trip, with no risk of a caller mistaking "the
   * collaborator row exists" for "the diagram exists": the query starts from `diagrams` and
   * only ever returns a row when a matching diagram is actually found.
   *
   * `findOwned()` itself is not changed or removed by this method -- every genuinely
   * owner-only route keeps calling it exactly as before.
   *
   * @param id Diagram id from the request path.
   * @param email Verified Cloudflare Access identity making the request.
   * @returns The diagram and the caller's role, or `null` if the diagram does not exist, or
   * exists but `email` is neither its owner nor one of its collaborators.
   */
  async findAccessible(
    id: string,
    email: string,
  ): Promise<{ diagram: Diagram; role: "owner" | "editor" } | null> {
    const row = await this.database
      .prepare(
        `SELECT d.id, d.owner_email, d.title, d.description, d.graph_data, d.created_at, d.updated_at,
                CASE WHEN d.owner_email = ?2 THEN 'owner' ELSE 'editor' END AS role
         FROM diagrams d
         WHERE d.id = ?1
           AND (
             d.owner_email = ?2
             OR EXISTS (
               SELECT 1 FROM diagram_collaborators dc
               WHERE dc.diagram_id = d.id AND dc.collaborator_email = ?2
             )
           )
         LIMIT 1`,
      )
      .bind(id, email)
      .first<DiagramRow & { role: "owner" | "editor" }>();
    if (row === null) {
      return null;
    }
    return { diagram: toDiagram(row), role: row.role };
  }

  /**
   * List every diagram `email` has been granted collaborator access to (never diagrams it
   * owns), most recently updated first -- the dashboard's "Shared with me" section
   * (`GET /api/diagrams/shared-with-me`, docs/09C-COLLABORATIVE-EDITING.md). Each returned
   * `Diagram` already carries `ownerEmail`, so the client can render "Shared by \<owner\>"
   * without a second request.
   *
   * @param email Verified Cloudflare Access identity making the request.
   * @returns Diagrams `email` collaborates on, newest activity first.
   */
  async listSharedWith(email: string): Promise<Diagram[]> {
    const { results } = await this.database
      .prepare(
        `SELECT d.id, d.owner_email, d.title, d.description, d.graph_data, d.created_at, d.updated_at
         FROM diagrams d
         JOIN diagram_collaborators dc ON dc.diagram_id = d.id
         WHERE dc.collaborator_email = ?
         ORDER BY d.updated_at DESC`,
      )
      .bind(email)
      .all<DiagramRow>();
    return results.map(toDiagram);
  }

  /**
   * List every diagram owned by `ownerEmail`, most recently updated first -- the dashboard's
   * card grid (docs/09-ARCHITECT.md Phase 2). Includes each diagram's full `graph_data` (not
   * just metadata) since the dashboard renders a live thumbnail preview of each diagram's graph.
   *
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The identity's own diagrams, newest activity first.
   */
  async listOwned(ownerEmail: string): Promise<Diagram[]> {
    const { results } = await this.database
      .prepare(
        `SELECT id, owner_email, title, description, graph_data, created_at, updated_at
         FROM diagrams WHERE owner_email = ? ORDER BY updated_at DESC`,
      )
      .bind(ownerEmail)
      .all<DiagramRow>();
    return results.map(toDiagram);
  }

  /**
   * Update a diagram's title and/or description, scoped to its owner.
   *
   * @param id Diagram id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @param fields Validated fields to update; an omitted field is left unchanged.
   * @returns The updated diagram, or `null` if it does not exist or is not owned by
   * `ownerEmail`.
   */
  async updateMetadata(
    id: string,
    ownerEmail: string,
    fields: UpdateDiagramInput,
  ): Promise<Diagram | null> {
    const existing = await this.findOwned(id, ownerEmail);
    if (existing === null) {
      return null;
    }

    const title = fields.title ?? existing.title;
    const description =
      fields.description === undefined
        ? existing.description
        : fields.description;
    const updatedAt = new Date().toISOString();

    await this.database
      .prepare(
        `UPDATE diagrams SET title = ?, description = ?, updated_at = ?
         WHERE id = ? AND owner_email = ?`,
      )
      .bind(title, description, updatedAt, id, ownerEmail)
      .run();

    return { ...existing, description, title, updatedAt };
  }

  /**
   * Replace a diagram's entire `graph_data` -- the autosave path
   * (`PUT /api/diagrams/:id/graph`). There is no partial-patch protocol: the client always sends
   * the complete, canonicalized graph (`../diagrams/validation.ts`'s `validateGraphDataInput()`).
   *
   * @param id Diagram id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @param graphData Canonical, already-validated JSON string to persist verbatim.
   * @returns The new `updatedAt` timestamp, or `null` if the diagram does not exist or is not
   * owned by `ownerEmail`.
   */
  async saveGraphData(
    id: string,
    ownerEmail: string,
    graphData: string,
  ): Promise<string | null> {
    const updatedAt = new Date().toISOString();
    const result = await this.database
      .prepare(
        `UPDATE diagrams SET graph_data = ?, updated_at = ?
         WHERE id = ? AND owner_email = ?`,
      )
      .bind(graphData, updatedAt, id, ownerEmail)
      .run();
    return result.meta.changes > 0 ? updatedAt : null;
  }

  /**
   * Delete a diagram, scoped to its owner.
   *
   * @param id Diagram id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns Whether a row was actually deleted.
   */
  async remove(id: string, ownerEmail: string): Promise<boolean> {
    const result = await this.database
      .prepare(`DELETE FROM diagrams WHERE id = ? AND owner_email = ?`)
      .bind(id, ownerEmail)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Load a diagram regardless of owner -- `../diagram-session/diagram-session.ts`'s
   * `DiagramSession.ensureHydrated()` hydration path, mirroring `removeAny()`'s no-scoping
   * precedent below: the Worker has already authorized the caller (owner or collaborator, via
   * `findAccessible()`) *before* ever reaching that Durable Object, so this method performs no
   * authorization of its own and must never be reachable from a request this repository itself
   * has not already scoped. Callers must only reach this method from `DiagramSession`, never
   * from an ordinary owner- or accessibility-scoped request.
   *
   * @param id Diagram id to load.
   * @returns The diagram, or `null` if it no longer exists (for example, deleted in the narrow
   * window between the Worker's own authorization check and this call).
   */
  async findAny(id: string): Promise<Diagram | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, title, description, graph_data, created_at, updated_at
         FROM diagrams WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<DiagramRow>();
    return row === null ? null : toDiagram(row);
  }

  /**
   * Delete a diagram regardless of owner -- the admin moderation delete
   * (`DELETE /api/admin/diagrams/:id`, docs/09-ARCHITECT.md Phase 4). Unlike `remove()`, this
   * performs no ownership scoping of its own: callers must only reach this method from a route
   * already gated by `../middleware/admin.ts`'s `requireAdmin`, never from an ordinary owner-
   * scoped request.
   *
   * @param id Diagram id from the request path.
   * @returns Whether a row was actually deleted.
   */
  async removeAny(id: string): Promise<boolean> {
    const result = await this.database
      .prepare(`DELETE FROM diagrams WHERE id = ?`)
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Load only the fields safe to show an anonymous share viewer -- deliberately never
   * `ownerEmail` (docs/09-ARCHITECT.md's non-negotiable tests: a public share must never leak
   * membership data). Callers must have already resolved a valid, unrevoked share token to `id`
   * via `../shares/repository.ts`'s `ShareRepository.resolve()`; this method performs no
   * authorization check of its own and must never be reachable from an id a caller merely
   * guessed.
   *
   * @param id Diagram id resolved from a valid share token.
   * @returns The diagram's public fields, or `null` if it no longer exists.
   */
  async findPublicFields(id: string): Promise<SharedDiagram | null> {
    const row = await this.database
      .prepare(
        `SELECT id, title, description, graph_data FROM diagrams WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<Pick<DiagramRow, "id" | "title" | "description" | "graph_data">>();
    if (row === null) {
      return null;
    }
    return {
      description: row.description,
      graphData: row.graph_data,
      id: row.id,
      title: row.title,
    };
  }
}
