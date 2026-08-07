import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { Diagram } from "./types";

/** Raw snake-cased diagram row returned by D1. */
interface DiagramRow {
  id: string;
  owner_email: string;
  title: string;
  created_at: string;
  updated_at: string;
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
 * ownership, title, and timestamps.
 *
 * Phase 2 has no editor membership yet, so every lookup filters on `owner_email` directly;
 * Phase 3 extends authorization to `diagram_members` without changing this repository's public
 * shape.
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
   * List every diagram owned by one verified identity, most recently updated first.
   *
   * @param ownerEmail Verified Cloudflare Access email.
   * @returns The identity's owned diagrams.
   */
  async listOwnedBy(ownerEmail: string): Promise<Diagram[]> {
    const result = await this.database
      .prepare(
        "SELECT id, owner_email, title, created_at, updated_at FROM diagrams WHERE owner_email = ? ORDER BY updated_at DESC",
      )
      .bind(ownerEmail)
      .all<DiagramRow>();
    return result.results.map(toDiagram);
  }

  /**
   * Read one diagram, enforcing the owner boundary in the same query.
   *
   * @param ownerEmail Verified Cloudflare Access email.
   * @param id Validated diagram UUID.
   * @returns The owned diagram.
   * @throws {ProblemDetailsError} `notFound()` when the diagram does not exist or is not owned
   * by `ownerEmail` — the two cases are indistinguishable to the caller by design.
   */
  async getOwned(ownerEmail: string, id: string): Promise<Diagram> {
    const row = await this.database
      .prepare(
        "SELECT id, owner_email, title, created_at, updated_at FROM diagrams WHERE id = ? AND owner_email = ? LIMIT 1",
      )
      .bind(id, ownerEmail)
      .first<DiagramRow>();
    if (row === null) {
      throw notFound({ detail: "Diagram not found." });
    }
    return toDiagram(row);
  }

  /**
   * Rename a diagram owned by one verified identity.
   *
   * @param ownerEmail Verified Cloudflare Access email.
   * @param id Validated diagram UUID.
   * @param title Validated replacement title.
   * @returns The renamed diagram.
   * @throws {ProblemDetailsError} `notFound()` when the diagram is not owned by `ownerEmail`.
   */
  async rename(
    ownerEmail: string,
    id: string,
    title: string,
  ): Promise<Diagram> {
    const existing = await this.getOwned(ownerEmail, id);
    const updatedAt = new Date().toISOString();
    await this.database
      .prepare(
        "UPDATE diagrams SET title = ?, updated_at = ? WHERE id = ? AND owner_email = ?",
      )
      .bind(title, updatedAt, id, ownerEmail)
      .run();
    return { ...existing, title, updatedAt };
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
