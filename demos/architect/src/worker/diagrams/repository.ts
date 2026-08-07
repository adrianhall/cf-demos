import { forbidden, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { Diagram, DiagramMember } from "./types";

/** Raw snake-cased diagram row returned by D1. */
interface DiagramRow {
  id: string;
  owner_email: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** A {@link DiagramRow} joined with the caller's `diagram_members.role` for one access check. */
interface DiagramMemberRow extends DiagramRow {
  role: string;
}

/** Convert a D1 row to the API's camel-cased diagram representation. */
function toDiagram(row: DiagramRow): Diagram {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1 persistence boundary for the diagram directory (`diagrams`, `diagram_members`). The live,
 * editable graph never lives here — see `DiagramRoom` — this repository only ever manages
 * ownership/membership, title, and timestamps.
 *
 * Phase 3 widens every list/open/rename check from Phase 2's `owner_email`-only predicate to
 * `diagram_members` membership (`getAccessible()`, `listAccessibleBy()`): any owner **or**
 * editor may list, open, and rename a diagram. Invitation management and (Phase 6) publishing
 * stay owner-only via the separate `requireOwner()` check, which — unlike `getAccessible()` —
 * distinguishes "not a member at all" (`404`) from "a confirmed editor attempting an owner-only
 * action" (`403`).
 */
export class DiagramRepository {
  /** @param database D1 capability used to query and update the directory. */
  constructor(
    private readonly database: Pick<D1Database, "prepare" | "batch">,
  ) {}

  /**
   * Create a diagram and its owner membership row in one atomic D1 batch.
   *
   * @param ownerEmail Verified Cloudflare Access email of the creator.
   * @param title Validated diagram title.
   * @returns The newly persisted diagram.
   */
  async create(ownerEmail: string, title: string): Promise<Diagram> {
    const timestamp = new Date().toISOString();
    const diagram: Diagram = {
      id: crypto.randomUUID(),
      ownerEmail,
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO diagrams (id, owner_email, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          diagram.id,
          diagram.ownerEmail,
          diagram.title,
          diagram.createdAt,
          diagram.updatedAt,
        ),
      this.database
        .prepare(
          "INSERT INTO diagram_members (diagram_id, email, role, joined_at) VALUES (?, ?, 'owner', ?)",
        )
        .bind(diagram.id, ownerEmail, timestamp),
    ]);
    return diagram;
  }

  /**
   * List every diagram one verified identity can access — owner or editor membership — most
   * recently updated first.
   *
   * @param email Verified Cloudflare Access email.
   * @returns The identity's accessible diagrams.
   */
  async listAccessibleBy(email: string): Promise<Diagram[]> {
    const result = await this.database
      .prepare(
        `SELECT d.id, d.owner_email, d.title, d.created_at, d.updated_at
         FROM diagrams d
         JOIN diagram_members m ON m.diagram_id = d.id
         WHERE m.email = ?
         ORDER BY d.updated_at DESC`,
      )
      .bind(email)
      .all<DiagramRow>();
    return result.results.map(toDiagram);
  }

  /**
   * Read one diagram, enforcing Phase 3's membership boundary (owner **or** editor) in the same
   * query.
   *
   * @param email Verified Cloudflare Access email.
   * @param id Validated diagram UUID.
   * @returns The accessible diagram.
   * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or `email` has no
   * `diagram_members` row for it — the two cases are indistinguishable to the caller by design,
   * exactly matching Phase 2's owner-only `getOwned()` behavior this replaces.
   */
  async getAccessible(email: string, id: string): Promise<Diagram> {
    const row = await this.memberRow(email, id);
    if (row === null) {
      throw notFound({ detail: "Diagram not found." });
    }
    return toDiagram(row);
  }

  /**
   * Read one diagram and additionally enforce that `email` is specifically its **owner** — used
   * by invitation management (this phase) and publishing (Phase 6), where editor membership is
   * not sufficient.
   *
   * @param email Verified Cloudflare Access email.
   * @param id Validated diagram UUID.
   * @returns The owned diagram.
   * @throws {ProblemDetailsError} `notFound()` when `email` has no membership at all — a
   * non-member probe must not be able to tell an owner-only diagram apart from one that does not
   * exist. `forbidden()` when `email` is a confirmed editor member attempting an owner-only
   * action — a legitimately different case, since that identity's membership is already known.
   */
  async requireOwner(email: string, id: string): Promise<Diagram> {
    const row = await this.memberRow(email, id);
    if (row === null) {
      throw notFound({ detail: "Diagram not found." });
    }
    if (row.role !== "owner") {
      throw forbidden({ detail: "Only the diagram's owner can do this." });
    }
    return toDiagram(row);
  }

  /**
   * Rename a diagram. Any member — owner or editor — may rename, matching Phase 3's "owner and
   * editor can edit" rule extended to a diagram's title, not only its live document.
   *
   * @param email Verified Cloudflare Access email.
   * @param id Validated diagram UUID.
   * @param title Validated replacement title.
   * @returns The renamed diagram.
   * @throws {ProblemDetailsError} `notFound()` when `email` has no membership for this diagram.
   */
  async rename(email: string, id: string, title: string): Promise<Diagram> {
    const existing = await this.getAccessible(email, id);
    const updatedAt = new Date().toISOString();
    await this.database
      .prepare("UPDATE diagrams SET title = ?, updated_at = ? WHERE id = ?")
      .bind(title, updatedAt, id)
      .run();
    return { ...existing, title, updatedAt };
  }

  /**
   * List every member of a diagram, owner first.
   *
   * Callers must already have verified diagram access (`getAccessible()`/`requireOwner()`) —
   * this method does not repeat that check, matching `touchUpdatedAt()`'s pattern below.
   *
   * @param diagramId Diagram to list members for.
   * @returns Every member, owner first, then editors by join order.
   */
  async listMembers(diagramId: string): Promise<DiagramMember[]> {
    const result = await this.database
      .prepare(
        "SELECT email, role FROM diagram_members WHERE diagram_id = ? ORDER BY role DESC, joined_at ASC",
      )
      .bind(diagramId)
      .all<{ email: string; role: string }>();
    return result.results.map((row) => ({
      email: row.email,
      role: row.role as DiagramMember["role"],
    }));
  }

  /**
   * Add a member, doing nothing if the identity already has a `diagram_members` row.
   *
   * Idempotent by design so redeeming an invitation for an identity that is already a member —
   * including the diagram's own owner — never duplicates or downgrades their existing role. See
   * `../invitations/repository.ts`'s `redeem()`, whose caller (`../routes/invitations.ts`) calls
   * this immediately after a successful redemption.
   *
   * @param diagramId Diagram to add the member to.
   * @param email Verified Cloudflare Access email of the new member.
   * @param role Role to grant if `email` has no existing membership row.
   */
  async addMember(
    diagramId: string,
    email: string,
    role: DiagramMember["role"],
  ): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO diagram_members (diagram_id, email, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (diagram_id, email) DO NOTHING`,
      )
      .bind(diagramId, email, role, new Date().toISOString())
      .run();
  }

  /** Read one diagram row joined with `email`'s membership role, or `null` if no such row exists. */
  private async memberRow(
    email: string,
    id: string,
  ): Promise<DiagramMemberRow | null> {
    return this.database
      .prepare(
        `SELECT d.id, d.owner_email, d.title, d.created_at, d.updated_at, m.role
         FROM diagrams d
         JOIN diagram_members m ON m.diagram_id = d.id
         WHERE d.id = ? AND m.email = ?
         LIMIT 1`,
      )
      .bind(id, email)
      .first<DiagramMemberRow>();
  }

  /**
   * Record that a diagram's document changed without altering its title.
   *
   * Called after an accepted `DiagramRoom` operation so the directory's `updated_at` reflects
   * document edits, not only renames.
   *
   * @param id Validated diagram UUID. Ownership was already checked by the caller before the
   * Durable Object call this follows, so this update does not repeat that check.
   * @returns Promise resolved after the timestamp is updated.
   */
  async touchUpdatedAt(id: string): Promise<void> {
    await this.database
      .prepare("UPDATE diagrams SET updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
  }
}
