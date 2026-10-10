import { describe, expect, it } from "vitest";
import { ShareRepository } from "./repository";

/** In-memory shape of one `diagram_shares` row, matching the migration's columns. */
interface DiagramShareRow {
  token_digest: string;
  diagram_id: string;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Minimal, *stateful* in-memory D1 double for the `diagram_shares` table. Unlike
 * `../diagrams/repository.test.ts`'s per-test fixed-response fake, this one actually stores and
 * mutates rows: `ShareRepository.rotate()` chains a `SELECT` (to find any active share), an
 * `UPDATE` (to revoke it), and an `INSERT` (the new one) within a single call, and the
 * interactions between those statements are exactly what these tests verify -- mirroring
 * `demos/url-shortener`'s stateful `FakeKVNamespace`.
 */
class FakeD1 {
  rows: DiagramShareRow[] = [];

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const selectMatch =
      /^SELECT (\w+) FROM diagram_shares WHERE (diagram_id|token_digest) = \?/u.exec(
        normalized,
      );
    const isInsert = normalized.startsWith("INSERT INTO diagram_shares");
    const isUpdateByToken = normalized.startsWith(
      "UPDATE diagram_shares SET revoked_at = ? WHERE token_digest = ?",
    );
    const isUpdateByDiagram = normalized.startsWith(
      "UPDATE diagram_shares SET revoked_at = ? WHERE diagram_id = ?",
    );

    const rows = this.rows;
    let params: unknown[] = [];

    const statement = {
      bind: (...values: unknown[]) => {
        params = values;
        return statement;
      },
      first: async <T>() => {
        if (!selectMatch) {
          throw new Error(`FakeD1: unhandled first() for "${normalized}"`);
        }
        const [, column, filterColumn] = selectMatch;
        const filterValue = params[0];
        const row = rows.find(
          (candidate) =>
            candidate[filterColumn as "diagram_id" | "token_digest"] ===
              filterValue && candidate.revoked_at === null,
        );
        return (
          row === undefined
            ? null
            : { [column as string]: row[column as keyof DiagramShareRow] }
        ) as T | null;
      },
      all: async <T>() => {
        if (!selectMatch) {
          throw new Error(`FakeD1: unhandled all() for "${normalized}"`);
        }
        const [, column, filterColumn] = selectMatch;
        const filterValue = params[0];
        const results = rows
          .filter(
            (candidate) =>
              candidate[filterColumn as "diagram_id" | "token_digest"] ===
                filterValue && candidate.revoked_at === null,
          )
          .map((row) => ({
            [column as string]: row[column as keyof DiagramShareRow],
          }));
        return { results: results as T[] };
      },
      run: async () => {
        if (isInsert) {
          const [tokenDigest, diagramId, createdAt] = params as [
            string,
            string,
            string,
          ];
          rows.push({
            created_at: createdAt,
            diagram_id: diagramId,
            revoked_at: null,
            token_digest: tokenDigest,
          });
          return { meta: { changes: 1 } };
        }
        if (isUpdateByToken) {
          const [revokedAt, tokenDigest] = params as [string, string];
          const row = rows.find(
            (candidate) => candidate.token_digest === tokenDigest,
          );
          const changed = row !== undefined && row.revoked_at === null;
          if (row) row.revoked_at = revokedAt;
          return { meta: { changes: changed ? 1 : 0 } };
        }
        if (isUpdateByDiagram) {
          const [revokedAt, diagramId] = params as [string, string];
          let changes = 0;
          for (const row of rows) {
            if (row.diagram_id === diagramId && row.revoked_at === null) {
              row.revoked_at = revokedAt;
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        throw new Error(`FakeD1: unhandled run() for "${normalized}"`);
      },
    };
    return statement;
  }
}

/** Minimal in-memory Workers KV double: a plain `Map` keyed by the SHA-256 token digest. */
class FakeKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Build a fresh {@link ShareRepository} backed by fresh fakes, for test isolation. */
function repositoryFor() {
  const database = new FakeD1();
  const kv = new FakeKV();
  return {
    database,
    kv,
    repository: new ShareRepository(
      database as unknown as Pick<D1Database, "prepare">,
      kv as unknown as Pick<KVNamespace, "get" | "put" | "delete">,
    ),
  };
}

describe("ShareRepository", () => {
  it("reports inactive status for a diagram with no share", async () => {
    const { repository } = repositoryFor();
    expect(await repository.getStatus("d1")).toEqual({
      active: false,
      createdAt: null,
    });
  });

  it("mints a token whose SHA-256 digest -- never the raw token -- is the only thing persisted", async () => {
    const { database, kv, repository } = repositoryFor();
    const { token, createdAt } = await repository.rotate("d1");

    expect(token).toMatch(/^[\w-]{43}$/u);
    expect(createdAt).toBeTruthy();

    // D1's primary key and the KV key are both a 64-character hex SHA-256 digest -- never the
    // 43-character raw token itself -- and neither store ever contains the raw token as a value.
    expect(database.rows).toHaveLength(1);
    expect(database.rows[0]?.token_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(database.rows[0]?.token_digest).not.toBe(token);
    const [kvKey] = [...kv.store.keys()];
    expect(kvKey).toBe(database.rows[0]?.token_digest);
    expect([...kv.store.keys()].includes(token)).toBe(false);
    expect([...kv.store.values()].includes(token)).toBe(false);

    const status = await repository.getStatus("d1");
    expect(status).toEqual({ active: true, createdAt });
  });

  it("resolves a freshly minted token back to its diagram id", async () => {
    const { repository } = repositoryFor();
    const { token } = await repository.rotate("diagram-abc");
    expect(await repository.resolve(token)).toBe("diagram-abc");
  });

  it("returns null when resolving an unknown token", async () => {
    const { repository } = repositoryFor();
    expect(await repository.resolve("Z".repeat(43))).toBeNull();
  });

  it("falls back to D1 and backfills KV when a KV entry is missing", async () => {
    const { database, kv, repository } = repositoryFor();
    const { token } = await repository.rotate("diagram-xyz");

    // Simulate a KV read miss (eventual consistency across colos) with the D1 row still intact.
    const digest = [...kv.store.keys()][0] as string;
    kv.store.delete(digest);
    expect(database.rows).toHaveLength(1);

    expect(await repository.resolve(token)).toBe("diagram-xyz");
    // The fallback backfilled KV so a subsequent read no longer needs the D1 fallback.
    expect(kv.store.get(digest)).toBe("diagram-xyz");
  });

  it("rotating a diagram's share revokes the previous one", async () => {
    const { database, kv, repository } = repositoryFor();
    const first = await repository.rotate("d1");
    expect(kv.store.size).toBe(1);

    const second = await repository.rotate("d1");

    expect(await repository.resolve(first.token)).toBeNull();
    expect(await repository.resolve(second.token)).toBe("d1");
    expect(kv.store.size).toBe(1);
    expect(database.rows.filter((row) => row.revoked_at === null)).toHaveLength(
      1,
    );
    expect(database.rows).toHaveLength(2);
  });

  it("revokeActive returns false and changes nothing when no share is active", async () => {
    const { repository } = repositoryFor();
    expect(await repository.revokeActive("no-such-diagram")).toBe(false);
  });

  it("revokeActive revokes the active share and removes its KV entry", async () => {
    const { kv, repository } = repositoryFor();
    const { token } = await repository.rotate("d1");

    expect(await repository.revokeActive("d1")).toBe(true);

    expect(await repository.resolve(token)).toBeNull();
    expect(kv.store.size).toBe(0);
    expect((await repository.getStatus("d1")).active).toBe(false);
  });

  it("revokeAllForDiagram is a no-op for a diagram with no shares", async () => {
    const { database, repository } = repositoryFor();
    await repository.revokeAllForDiagram("no-such-diagram");
    expect(database.rows).toHaveLength(0);
  });

  it("revokeAllForDiagram revokes the active share and clears its KV entry", async () => {
    const { kv, repository } = repositoryFor();
    const { token } = await repository.rotate("d1");

    await repository.revokeAllForDiagram("d1");

    expect(await repository.resolve(token)).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it("does not disturb another diagram's active share", async () => {
    const { repository } = repositoryFor();
    const other = await repository.rotate("other-diagram");
    await repository.rotate("d1");

    await repository.revokeAllForDiagram("d1");

    expect(await repository.resolve(other.token)).toBe("other-diagram");
  });
});
