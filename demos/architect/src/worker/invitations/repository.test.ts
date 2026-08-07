import { describe, expect, it } from "vitest";
import { digestInvitationToken } from "./token";
import { InvitationRepository } from "./repository";

/** One `diagram_invites` row, as the in-memory D1 double stores it. */
interface StoredInvite {
  id: string;
  token_digest: string;
  diagram_id: string;
  creator_email: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by_email: string | null;
  revoked_at: string | null;
}

/**
 * A minimal in-memory D1 double that actually evaluates the repository's `WHERE` clauses,
 * because `redeem()`'s single-use guarantee depends on the real conditional-`UPDATE` semantics
 * that a simple "return this canned row" double (like `../diagrams/repository.test.ts`'s) cannot
 * exercise.
 */
function databaseFor(initial: StoredInvite[] = []): {
  database: Pick<D1Database, "prepare">;
  rows: StoredInvite[];
} {
  const rows: StoredInvite[] = [...initial];

  const database = {
    prepare(sql: string) {
      const bound: { parameters: unknown[] } = { parameters: [] };
      return {
        bind(...parameters: unknown[]) {
          bound.parameters = parameters;
          return this;
        },
        async all<T>() {
          const results = evaluateSelect(sql, rows, bound.parameters) as T[];
          return {
            meta: {
              changed_db: false,
              changes: 0,
              duration: 0,
              last_row_id: 0,
              rows_read: results.length,
              rows_written: 0,
              size_after: 0,
            },
            results,
            success: true as const,
          };
        },
        async first<T>() {
          const results = evaluateSelect(sql, rows, bound.parameters) as T[];
          return results[0] ?? null;
        },
        async raw<T>(): Promise<[string[], ...T[]]> {
          return [[], [] as T];
        },
        async run<T>() {
          const changes = evaluateWrite(sql, rows, bound.parameters);
          return {
            meta: {
              changed_db: changes > 0,
              changes,
              duration: 0,
              last_row_id: 0,
              rows_read: 0,
              rows_written: changes,
              size_after: 0,
            },
            results: [] as T[],
            success: true as const,
          };
        },
      };
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, rows };
}

/** Evaluate the small set of `SELECT`/`INSERT` statements `InvitationRepository` issues. */
function evaluateSelect(
  sql: string,
  rows: StoredInvite[],
  parameters: unknown[],
): unknown[] {
  if (sql.startsWith("INSERT")) {
    return [];
  }
  if (sql.includes("WHERE diagram_id = ? AND revoked_at IS NULL")) {
    const [diagramId, now] = parameters as [string, string];
    return rows
      .filter(
        (row) =>
          row.diagram_id === diagramId &&
          row.revoked_at === null &&
          row.redeemed_at === null &&
          row.expires_at > now,
      )
      .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  }
  if (sql.startsWith("SELECT diagram_id FROM diagram_invites")) {
    const [digest] = parameters as [string];
    const row = rows.find((candidate) => candidate.token_digest === digest);
    return row ? [{ diagram_id: row.diagram_id }] : [];
  }
  if (sql.startsWith("SELECT 1 FROM diagram_invites")) {
    const [digest] = parameters as [string];
    return rows.some((candidate) => candidate.token_digest === digest)
      ? [{ 1: 1 }]
      : [];
  }
  throw new Error(`Unhandled SELECT in test double: ${sql}`);
}

/** Evaluate the small set of `INSERT`/`UPDATE` statements `InvitationRepository` issues. */
function evaluateWrite(
  sql: string,
  rows: StoredInvite[],
  parameters: unknown[],
): number {
  if (sql.startsWith("INSERT INTO diagram_invites")) {
    const [id, tokenDigest, diagramId, creatorEmail, expiresAt] =
      parameters as [string, string, string, string, string];
    rows.push({
      creator_email: creatorEmail,
      diagram_id: diagramId,
      expires_at: expiresAt,
      id,
      redeemed_at: null,
      redeemed_by_email: null,
      revoked_at: null,
      token_digest: tokenDigest,
    });
    return 1;
  }
  if (sql.includes("SET redeemed_at = ?, redeemed_by_email = ?")) {
    const [redeemedAt, redeemedBy, digest, now] = parameters as [
      string,
      string,
      string,
      string,
    ];
    const row = rows.find(
      (candidate) =>
        candidate.token_digest === digest &&
        candidate.redeemed_at === null &&
        candidate.revoked_at === null &&
        candidate.expires_at > now,
    );
    if (!row) {
      return 0;
    }
    row.redeemed_at = redeemedAt;
    row.redeemed_by_email = redeemedBy;
    return 1;
  }
  if (sql.includes("SET revoked_at = ?")) {
    const [revokedAt, invitationId, diagramId] = parameters as [
      string,
      string,
      string,
    ];
    const row = rows.find(
      (candidate) =>
        candidate.id === invitationId &&
        candidate.diagram_id === diagramId &&
        candidate.revoked_at === null,
    );
    if (!row) {
      return 0;
    }
    row.revoked_at = revokedAt;
    return 1;
  }
  throw new Error(`Unhandled write in test double: ${sql}`);
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("InvitationRepository", () => {
  it("creates an invitation and returns the raw token exactly once", async () => {
    const { database, rows } = databaseFor();
    const repository = new InvitationRepository(database);

    const { invitation, token } = await repository.create(
      "diagram-1",
      "owner@example.com",
    );

    expect(invitation).toMatchObject({
      creatorEmail: "owner@example.com",
      diagramId: "diagram-1",
    });
    expect(token).toHaveLength(43);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_digest).toBe(await digestInvitationToken(token));
    // The raw token is never itself persisted.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("lists only active invitations for the given diagram", async () => {
    const { database } = databaseFor([
      {
        creator_email: "owner@example.com",
        diagram_id: "diagram-1",
        expires_at: FUTURE,
        id: "active",
        redeemed_at: null,
        redeemed_by_email: null,
        revoked_at: null,
        token_digest: "digest-active",
      },
      {
        creator_email: "owner@example.com",
        diagram_id: "diagram-1",
        expires_at: PAST,
        id: "expired",
        redeemed_at: null,
        redeemed_by_email: null,
        revoked_at: null,
        token_digest: "digest-expired",
      },
      {
        creator_email: "owner@example.com",
        diagram_id: "diagram-1",
        expires_at: FUTURE,
        id: "revoked",
        redeemed_at: null,
        redeemed_by_email: null,
        revoked_at: new Date().toISOString(),
        token_digest: "digest-revoked",
      },
      {
        creator_email: "owner@example.com",
        diagram_id: "diagram-1",
        expires_at: FUTURE,
        id: "redeemed",
        redeemed_at: new Date().toISOString(),
        redeemed_by_email: "editor@example.com",
        revoked_at: null,
        token_digest: "digest-redeemed",
      },
      {
        creator_email: "owner2@example.com",
        diagram_id: "diagram-2",
        expires_at: FUTURE,
        id: "other-diagram",
        redeemed_at: null,
        redeemed_by_email: null,
        revoked_at: null,
        token_digest: "digest-other",
      },
    ]);

    const active = await new InvitationRepository(database).listActive(
      "diagram-1",
    );

    expect(active.map((invitation) => invitation.id)).toEqual(["active"]);
  });

  it("revokes an active invitation", async () => {
    const { database, rows } = databaseFor([
      {
        creator_email: "owner@example.com",
        diagram_id: "diagram-1",
        expires_at: FUTURE,
        id: "invite-1",
        redeemed_at: null,
        redeemed_by_email: null,
        revoked_at: null,
        token_digest: "digest-1",
      },
    ]);

    await new InvitationRepository(database).revoke("diagram-1", "invite-1");

    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("revoking an unknown invitation id is a harmless no-op", async () => {
    const { database } = databaseFor();
    await expect(
      new InvitationRepository(database).revoke("diagram-1", "does-not-exist"),
    ).resolves.toBeUndefined();
  });

  it("redeems an active invitation exactly once and rejects reuse", async () => {
    const { database, rows } = databaseFor();
    const repository = new InvitationRepository(database);
    const { token } = await repository.create("diagram-1", "owner@example.com");

    const first = await repository.redeem(token, "editor@example.com");
    expect(first).toEqual({ diagramId: "diagram-1" });
    expect(rows[0].redeemed_by_email).toBe("editor@example.com");

    await expect(
      repository.redeem(token, "editor@example.com"),
    ).rejects.toMatchObject({ problemDetails: { status: 410 } });
  });

  it("rejects redeeming an unknown token with notFound()", async () => {
    const { database } = databaseFor();
    const unknownToken = "A".repeat(43);
    await expect(
      new InvitationRepository(database).redeem(
        unknownToken,
        "editor@example.com",
      ),
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });

  it("rejects redeeming an expired invitation with gone()", async () => {
    const { database, rows } = databaseFor();
    const repository = new InvitationRepository(database);
    const { token } = await repository.create("diagram-1", "owner@example.com");
    rows[0].expires_at = PAST;

    await expect(
      repository.redeem(token, "editor@example.com"),
    ).rejects.toMatchObject({ problemDetails: { status: 410 } });
  });

  it("rejects redeeming a revoked invitation with gone()", async () => {
    const { database, rows } = databaseFor();
    const repository = new InvitationRepository(database);
    const { token } = await repository.create("diagram-1", "owner@example.com");
    rows[0].revoked_at = new Date().toISOString();

    await expect(
      repository.redeem(token, "editor@example.com"),
    ).rejects.toMatchObject({ problemDetails: { status: 410 } });
  });
});
