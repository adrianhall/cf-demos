import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import type { DiagramRepository } from "../diagrams/repository";
import type { UserRepository } from "../users/repository";
import type { Collaborator } from "./types";

/** Raw snake-cased collaborator row, left-joined against `users`, as returned by D1. */
interface CollaboratorRow {
  diagram_id: string;
  collaborator_email: string;
  added_by: string;
  added_at: string;
  display_name: string | null;
}

/** Convert D1's storage shape into the API representation. */
function toCollaborator(row: CollaboratorRow): Collaborator {
  return {
    addedAt: row.added_at,
    addedBy: row.added_by,
    diagramId: row.diagram_id,
    displayName: row.display_name,
    email: row.collaborator_email,
  };
}

/**
 * D1 persistence boundary for the `diagram_collaborators` table
 * (docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model Data Model): the owner-managed list of
 * other Cloudflare Access identities granted full edit access to a diagram. Mirrors
 * `../shares/repository.ts`'s shape (one repository class per table), but unlike that
 * repository, this one's `add()`/`remove()` methods perform their own authorization checks
 * inline -- collaborator management has more distinct rejection cases (self-add, never-signed-in
 * email, non-owner-non-self removal) than plain ownership scoping can express through a `WHERE`
 * clause alone -- rather than trusting a route handler to have already checked ownership, the
 * way `../shares/repository.ts`'s methods do.
 */
export class CollaboratorRepository {
  /**
   * @param database D1 capability used to prepare the repository's statements.
   * @param diagrams Used by `add()`/`remove()` to determine diagram ownership. Only `findOwned`
   * is needed.
   * @param users Used by `add()` to verify a candidate collaborator has signed in before. Only
   * `exists` is needed.
   */
  constructor(
    private readonly database: Pick<D1Database, "prepare">,
    private readonly diagrams: Pick<DiagramRepository, "findOwned">,
    private readonly users: Pick<UserRepository, "exists">,
  ) {}

  /**
   * Grant `collaboratorEmail` full edit access to a diagram owned by `ownerEmail`. Idempotent:
   * adding an already-added collaborator returns the existing row unchanged rather than erroring
   * or duplicating it, so a caller never has to special-case "already a collaborator" -- matches
   * docs/09C-COLLABORATIVE-EDITING.md's Collaborator Model table.
   *
   * @param diagramId Diagram id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @param collaboratorEmail Validated candidate email (`./validation.ts`'s
   * `validateAddCollaboratorInput()`).
   * @returns The collaborator row, whether newly created or already present.
   * @throws {ProblemDetailsError} `404` when `diagramId` does not exist or is not owned by
   * `ownerEmail` (matching this app's information-disclosure posture for owner-scoped routes),
   * or when `collaboratorEmail` has never signed in to this Access application (`../users`'s
   * directory) -- the client-visible detail never reveals which case applies. `400` when
   * `collaboratorEmail` is the diagram's own owner.
   */
  async add(
    diagramId: string,
    ownerEmail: string,
    collaboratorEmail: string,
  ): Promise<Collaborator> {
    if ((await this.diagrams.findOwned(diagramId, ownerEmail)) === null) {
      throw notFound({ detail: "Diagram not found." });
    }
    if (collaboratorEmail === ownerEmail) {
      throw badRequest({
        detail: "The diagram's owner cannot be added as a collaborator.",
      });
    }
    if (!(await this.users.exists(collaboratorEmail))) {
      throw notFound({
        detail:
          "That person needs to sign in to Architect at least once first.",
      });
    }

    const addedAt = new Date().toISOString();
    await this.database
      .prepare(
        `INSERT INTO diagram_collaborators (diagram_id, collaborator_email, added_by, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (diagram_id, collaborator_email) DO NOTHING`,
      )
      .bind(diagramId, collaboratorEmail, ownerEmail, addedAt)
      .run();

    // Re-select rather than trusting the just-bound values: when the row already existed, this
    // returns its original `added_by`/`added_at` -- the idempotent behavior this method's own
    // JSDoc promises -- rather than the values this call would have inserted.
    const row = await this.database
      .prepare(
        `SELECT dc.diagram_id, dc.collaborator_email, dc.added_by, dc.added_at, u.display_name
         FROM diagram_collaborators dc
         LEFT JOIN users u ON u.email = dc.collaborator_email
         WHERE dc.diagram_id = ? AND dc.collaborator_email = ?
         LIMIT 1`,
      )
      .bind(diagramId, collaboratorEmail)
      .first<CollaboratorRow>();
    // `row` is never null here: the INSERT above guarantees a matching row exists, whether just
    // inserted or already present from a prior call.
    return toCollaborator(row as CollaboratorRow);
  }

  /**
   * Remove one collaborator from a diagram. Allowed for the diagram's owner (removing anyone)
   * or for `actorEmail === collaboratorEmail` (a collaborator removing themselves -- "Leave
   * diagram") -- every other combination is rejected before touching the
   * `diagram_collaborators` table, matching docs/09C-COLLABORATIVE-EDITING.md's Collaborator
   * Model table.
   *
   * @param diagramId Diagram id from the request path.
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param collaboratorEmail Collaborator email to remove.
   * @returns Whether a row was actually deleted.
   * @throws {ProblemDetailsError} `404` when `actorEmail` is neither the diagram's owner nor
   * `collaboratorEmail` itself -- reported identically to "diagram not found", matching this
   * app's information-disclosure posture, rather than a `403` that would confirm the diagram
   * exists to a caller with no business seeing that.
   */
  async remove(
    diagramId: string,
    actorEmail: string,
    collaboratorEmail: string,
  ): Promise<boolean> {
    const isOwner =
      (await this.diagrams.findOwned(diagramId, actorEmail)) !== null;
    const isSelfRemoval = actorEmail === collaboratorEmail;
    if (!isOwner && !isSelfRemoval) {
      throw notFound({ detail: "Diagram not found." });
    }

    const result = await this.database
      .prepare(
        `DELETE FROM diagram_collaborators WHERE diagram_id = ? AND collaborator_email = ?`,
      )
      .bind(diagramId, collaboratorEmail)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * List every collaborator for a diagram, oldest-added first, joined against `users` for
   * `displayName` (currently always `null` -- see `./types.ts`'s `Collaborator.displayName`
   * JSDoc). Performs no ownership check of its own -- callers must have already confirmed the
   * caller may access this diagram (`../diagrams/repository.ts`'s `findAccessible()`).
   *
   * @param diagramId Diagram id from the request path.
   * @returns Every collaborator row for this diagram.
   */
  async list(diagramId: string): Promise<Collaborator[]> {
    const { results } = await this.database
      .prepare(
        `SELECT dc.diagram_id, dc.collaborator_email, dc.added_by, dc.added_at, u.display_name
         FROM diagram_collaborators dc
         LEFT JOIN users u ON u.email = dc.collaborator_email
         WHERE dc.diagram_id = ?
         ORDER BY dc.added_at ASC`,
      )
      .bind(diagramId)
      .all<CollaboratorRow>();
    return results.map(toCollaborator);
  }

  /**
   * Report whether `email` is a collaborator on `diagramId`. Used by
   * `../diagrams/repository.ts`'s `findAccessible()`.
   *
   * @param diagramId Diagram id.
   * @param email Candidate collaborator email.
   * @returns Whether a matching `diagram_collaborators` row exists.
   */
  async isCollaborator(diagramId: string, email: string): Promise<boolean> {
    const row = await this.database
      .prepare(
        `SELECT 1 FROM diagram_collaborators WHERE diagram_id = ? AND collaborator_email = ? LIMIT 1`,
      )
      .bind(diagramId, email)
      .first();
    return row !== null;
  }
}
