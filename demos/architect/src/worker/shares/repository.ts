import { problemDetails } from "@adrianhall/cloudflare-toolkit/problem-details";
import type { GraphDocument } from "../../graph/types";
import { digestShareToken, generateShareToken } from "./token";
import type { PublishedSnapshot, PublishResult, ShareStatus } from "./types";

/** Raw snake-cased `diagram_shares` row for one diagram's currently active (non-revoked) share. */
interface ActiveShareRow {
  token_digest: string;
  r2_object_key: string;
  publication_revision: number;
  created_at: string;
  updated_at: string;
}

/** Compute the deterministic, revision-addressed, never-reused R2 key for one published snapshot. */
function snapshotKeyFor(diagramId: string, revision: number): string {
  return `snapshots/${diagramId}/${revision}.json`;
}

/**
 * D1/R2/KV persistence boundary for Phase 6 public publishing (`docs/09-ARCHITECT.md`'s Phase 6
 * and Product Responsibilities table).
 *
 * - D1 (`diagram_shares`) is the owner-facing directory: one active row per diagram, keyed by
 *   its token's SHA-256 digest (never the raw token), tracking which R2 object and revision the
 *   current link points at and whether it has been revoked.
 * - R2 (`SNAPSHOTS`, shared with Phase 5's `proposals/<jobId>.json` objects under a *different*
 *   key prefix, `snapshots/<diagramId>/<revision>.json`) holds every published revision as an
 *   immutable, never-overwritten object — old revisions remain retrievable by key even after a
 *   republish, though only the current revision's key is ever reachable through a live token.
 * - KV (`SHARES`) is the fast, D1-independent anonymous lookup path: one entry per active share,
 *   keyed by the same token digest, whose value is simply the current R2 object key. Anonymous
 *   resolution (`../routes/shared.ts`) reads only this KV entry — never D1, never `DiagramRoom` —
 *   so a public request can never observe editable room state or diagram membership.
 */
export class ShareRepository {
  /**
   * @param database D1 capability used to query and update `diagram_shares`.
   * @param bucket R2 bucket bound as `SNAPSHOTS`, storing immutable published snapshots.
   * @param kv KV namespace bound as `SHARES`, the anonymous token-digest lookup path.
   */
  constructor(
    private readonly database: Pick<D1Database, "prepare">,
    private readonly bucket: Pick<R2Bucket, "put">,
    private readonly kv: Pick<KVNamespace, "put" | "delete">,
  ) {}

  /**
   * Publish (or republish/update) a diagram's current document as a new immutable revision.
   *
   * On a diagram's first publish, generates a fresh token and inserts a new `diagram_shares`
   * row. On every subsequent call for a diagram with an already-active (non-revoked) share, the
   * existing row's token digest is reused unchanged — its raw token was never persisted, so the
   * *link itself* keeps working (an already-shared bookmark or forwarded URL now resolves to the
   * new revision) even though the raw value cannot be returned again; only a fresh `POST` after
   * an explicit `revoke()` ever mints a new token. This mirrors `../invitations/repository.ts`'s
   * "shown once" pattern for exactly the same reason: nothing this server persists could reveal
   * the raw value even if it wanted to.
   *
   * @param diagramId Diagram being published. The caller (`../routes/diagrams.ts`) has already
   * confirmed the requester owns it via `DiagramRepository.requireOwner()`.
   * @param title The diagram's current title, embedded in the immutable snapshot.
   * @param revision The diagram's current `DiagramRoom` revision.
   * @param document The diagram's current graph document.
   * @returns The new revision and, on a first publish only, the one-time raw token.
   * @throws {ProblemDetailsError} A `409` (the toolkit has no dedicated `conflict()` generator —
   * `../routes/diagrams.ts`'s proposal-start route uses the same `problemDetails()` escape
   * hatch) in the exceedingly rare case that a genuinely concurrent request publishes a
   * *different* diagram's content at this exact key between this method's own read and write —
   * see the create-only `onlyIf` guard below. An owner clicking "republish" with no intervening
   * edit is *not* this case — see the very first check below.
   */
  async publish(
    diagramId: string,
    title: string,
    revision: number,
    document: GraphDocument,
  ): Promise<PublishResult> {
    const now = new Date().toISOString();
    const key = snapshotKeyFor(diagramId, revision);
    const active = await this.activeRow(diagramId);

    // Revision-addressed keys are deterministic: the *same* diagram at the *same* revision
    // always maps to the *same* key. An owner clicking "republish"/"update" with no intervening
    // edit since the last publish is therefore not a new revision at all — it is an ordinary,
    // harmless idempotent no-op, not a collision the create-only guard below needs to reject.
    // Short-circuiting here, before ever attempting the R2 write, is what keeps a legitimate
    // "nothing changed, republish anyway" click from ever hitting that guard's 409.
    if (active && active.publication_revision === revision) {
      return { revision, token: null };
    }

    const snapshot: PublishedSnapshot = { title, revision, document };
    // Create-only semantics: `If-None-Match: *` matches only when no object currently exists at
    // this key. `put()` returns `null` when the condition fails instead of writing anything, per
    // the R2 Workers API's own documented conditional-operation contract. Having already ruled
    // out the ordinary same-revision-republish case above, a `null` result here means a
    // genuinely concurrent request raced this exact write between this method's `activeRow()`
    // read and this `put()` call.
    const written = await this.bucket.put(key, JSON.stringify(snapshot), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (written === null) {
      // The racing writer's content is deterministically identical (same diagramId/revision, and
      // this method's caller always supplies the diagram's own current title/document for that
      // revision), so if the D1 row now reflects this exact key, treat this as the same success
      // the other caller already achieved rather than a user-visible error.
      const racedActive = await this.activeRow(diagramId);
      if (racedActive?.r2_object_key === key) {
        return { revision, token: null };
      }
      throw problemDetails({
        status: 409,
        title: "Conflict",
        detail: "This diagram revision has already been published.",
      });
    }

    if (active) {
      await this.database
        .prepare(
          "UPDATE diagram_shares SET r2_object_key = ?, publication_revision = ?, updated_at = ? WHERE token_digest = ?",
        )
        .bind(key, revision, now, active.token_digest)
        .run();
      await this.kv.put(active.token_digest, key);
      return { revision, token: null };
    }

    const token = generateShareToken();
    const digest = await digestShareToken(token);
    await this.database
      .prepare(
        "INSERT INTO diagram_shares (token_digest, diagram_id, r2_object_key, publication_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(digest, diagramId, key, revision, now, now)
      .run();
    await this.kv.put(digest, key);
    return { revision, token };
  }

  /**
   * Revoke a diagram's active share, if any.
   *
   * Idempotent: revoking a diagram with no active share succeeds silently, matching
   * `../invitations/repository.ts`'s `revoke()` idempotency. Removes the KV entry immediately —
   * per `docs/09-ARCHITECT.md`'s Phase 6, this deletion is eventually consistent across
   * Cloudflare's edge, which is an acceptable, explicitly documented window here because the
   * content was deliberately published publicly in the first place; this pattern must never be
   * reused for private data. The D1 row's `revoked_at` is the durable source of truth and is set
   * synchronously before the KV delete.
   *
   * @param diagramId Diagram to revoke publication for.
   */
  async revoke(diagramId: string): Promise<void> {
    const active = await this.activeRow(diagramId);
    if (!active) {
      return;
    }
    await this.database
      .prepare(
        "UPDATE diagram_shares SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL",
      )
      .bind(new Date().toISOString(), active.token_digest)
      .run();
    await this.kv.delete(active.token_digest);
  }

  /**
   * Read a diagram's current publication status, without ever exposing its token or digest.
   *
   * @param diagramId Diagram to read status for.
   * @returns `{ published: false }` when no active share exists, otherwise the published
   * revision and timestamps.
   */
  async getStatus(diagramId: string): Promise<ShareStatus> {
    const active = await this.activeRow(diagramId);
    if (!active) {
      return { published: false };
    }
    return {
      createdAt: active.created_at,
      published: true,
      revision: active.publication_revision,
      updatedAt: active.updated_at,
    };
  }

  /** Read the one active (non-revoked) `diagram_shares` row for a diagram, if any. */
  private async activeRow(diagramId: string): Promise<ActiveShareRow | null> {
    return this.database
      .prepare(
        "SELECT token_digest, r2_object_key, publication_revision, created_at, updated_at FROM diagram_shares WHERE diagram_id = ? AND revoked_at IS NULL LIMIT 1",
      )
      .bind(diagramId)
      .first<ActiveShareRow>();
  }
}
