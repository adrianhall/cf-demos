import { gone, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import { digestInvitationToken, generateInvitationToken } from "./token";
import type { CreateInvitationResult, InvitationSummary } from "./types";

/**
 * How long a created invitation remains redeemable.
 *
 * 48 hours balances two goals: giving an invited collaborator a realistic window to notice and
 * click the link (email/chat is rarely read within minutes), while keeping a lost or forwarded
 * link's exposure short. `docs/09-ARCHITECT.md`'s Phase 3 section leaves the exact duration to
 * this implementation, within its suggested 24-72 hour range.
 */
const INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1000;

/** Raw snake-cased `diagram_invites` row, excluding the sensitive `token_digest` column. */
interface InvitationRow {
  id: string;
  diagram_id: string;
  creator_email: string;
  expires_at: string;
}

/** Convert a D1 row to the API's camel-cased, digest-free invitation representation. */
function toSummary(row: InvitationRow): InvitationSummary {
  return {
    id: row.id,
    diagramId: row.diagram_id,
    creatorEmail: row.creator_email,
    expiresAt: row.expires_at,
  };
}

/**
 * D1 persistence boundary for `diagram_invites`.
 *
 * Stores only a SHA-256 digest of each raw invitation token (`./token.ts`); the raw token itself
 * is never persisted or logged — `create()` returns it to the caller exactly once, and every
 * other method here only ever sees or returns the digest-free {@link InvitationSummary} shape.
 */
export class InvitationRepository {
  /** @param database D1 capability used to query and update `diagram_invites`. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Create a new invitation for a diagram.
   *
   * @param diagramId Diagram the invitation grants editor access to.
   * @param creatorEmail Verified Cloudflare Access email of the diagram's owner. The caller
   * (`../routes/diagrams.ts`) has already confirmed this via `DiagramRepository.requireOwner()`.
   * @returns The persisted invitation summary and its one-time raw token.
   */
  async create(
    diagramId: string,
    creatorEmail: string,
  ): Promise<CreateInvitationResult> {
    const token = generateInvitationToken();
    const tokenDigest = await digestInvitationToken(token);
    const id = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + INVITATION_LIFETIME_MS,
    ).toISOString();

    await this.database
      .prepare(
        "INSERT INTO diagram_invites (id, token_digest, diagram_id, creator_email, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, tokenDigest, diagramId, creatorEmail, expiresAt)
      .run();

    return {
      invitation: { id, diagramId, creatorEmail, expiresAt },
      token,
    };
  }

  /**
   * List a diagram's currently redeemable invitations: not expired, not revoked, and not already
   * redeemed.
   *
   * A revoked, expired, or redeemed invitation simply stops appearing here — Phase 3 has no
   * invitation history view; only currently actionable invitations are worth showing the owner.
   *
   * @param diagramId Diagram to list invitations for.
   * @returns Active invitation summaries, soonest-expiring first.
   */
  async listActive(diagramId: string): Promise<InvitationSummary[]> {
    const result = await this.database
      .prepare(
        `SELECT id, diagram_id, creator_email, expires_at
         FROM diagram_invites
         WHERE diagram_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?
         ORDER BY expires_at ASC`,
      )
      .bind(diagramId, new Date().toISOString())
      .all<InvitationRow>();
    return result.results.map(toSummary);
  }

  /**
   * Revoke one invitation, scoped to its diagram.
   *
   * Idempotent by design: revoking an already-revoked, already-redeemed, or unknown invitation
   * id succeeds silently rather than reporting an error the owner cannot usefully act on — this
   * matches ordinary idempotent-`DELETE` semantics.
   *
   * @param diagramId Diagram the invitation must belong to.
   * @param invitationId Invitation's opaque id (see `InvitationSummary.id`), never the raw token
   * or its digest.
   */
  async revoke(diagramId: string, invitationId: string): Promise<void> {
    await this.database
      .prepare(
        "UPDATE diagram_invites SET revoked_at = ? WHERE id = ? AND diagram_id = ? AND revoked_at IS NULL",
      )
      .bind(new Date().toISOString(), invitationId, diagramId)
      .run();
  }

  /**
   * Redeem a raw invitation token: atomically claim it for single use, then report which
   * diagram it grants access to.
   *
   * The claiming `UPDATE` is the atomicity boundary — its `WHERE` clause repeats every validity
   * condition (`redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now`), so at most one
   * concurrent call can ever match and update a given row. `changes === 1` therefore means this
   * call won the single-use race outright; it never needs a separate read-then-write step that
   * could race with another redemption.
   *
   * @param token Raw token as submitted by the caller. Already shape-validated by
   * `./validation.ts` before this is called.
   * @param redeemerEmail Verified Cloudflare Access email of the caller.
   * @returns The invitation's diagram id.
   * @throws {ProblemDetailsError} `notFound()` when no invitation matches the token's digest at
   * all; `gone()` when a matching invitation exists but is expired, revoked, or was already
   * redeemed (by this or another caller).
   */
  async redeem(
    token: string,
    redeemerEmail: string,
  ): Promise<{ diagramId: string }> {
    const digest = await digestInvitationToken(token);
    const now = new Date().toISOString();

    const claim = await this.database
      .prepare(
        `UPDATE diagram_invites
         SET redeemed_at = ?, redeemed_by_email = ?
         WHERE token_digest = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(now, redeemerEmail, digest, now)
      .run();

    if (claim.meta.changes === 1) {
      const row = await this.database
        .prepare(
          "SELECT diagram_id FROM diagram_invites WHERE token_digest = ?",
        )
        .bind(digest)
        .first<{ diagram_id: string }>();
      throwIfNull(row, "Just-claimed invitation row must exist");
      return { diagramId: row.diagram_id };
    }

    // The atomic claim above matched no row — determine exactly why so the caller gets an
    // accurate RFC 9457 response (never a generic failure): either the digest is unknown, or it
    // is known but no longer valid for one of the three reasons the claim's own WHERE excluded.
    const existing = await this.database
      .prepare("SELECT 1 FROM diagram_invites WHERE token_digest = ?")
      .bind(digest)
      .first();
    if (existing === null) {
      throw notFound({ detail: "Invitation not found." });
    }
    throw gone({ detail: "This invitation is no longer valid." });
  }
}
