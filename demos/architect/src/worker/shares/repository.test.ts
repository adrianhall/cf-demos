import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../../graph/types";
import { ShareRepository } from "./repository";

/** One in-memory `diagram_shares` row, keyed exactly like the real D1 table. */
interface Row {
  token_digest: string;
  diagram_id: string;
  r2_object_key: string;
  publication_revision: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

/**
 * A minimal, genuinely stateful in-memory D1 double.
 *
 * Unlike a canned-response fake, {@link ShareRepository.publish} reads its own prior write back
 * (`activeRow()` after an `INSERT`/`UPDATE`), so this test double actually stores rows and
 * pattern-matches the repository's own fixed SQL text rather than returning one fixed value.
 */
function fakeDatabase(): Pick<D1Database, "prepare"> {
  const rows: Row[] = [];
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...parameters: unknown[]) {
          bound = parameters;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("WHERE diagram_id = ? AND revoked_at IS NULL")) {
            const [diagramId] = bound as [string];
            const row = rows.find(
              (candidate) =>
                candidate.diagram_id === diagramId &&
                candidate.revoked_at === null,
            );
            return (row ?? null) as T | null;
          }
          throw new Error(`Unhandled SELECT in fake D1: ${sql}`);
        },
        async run(): Promise<D1Result> {
          if (sql.startsWith("INSERT INTO diagram_shares")) {
            const [
              tokenDigest,
              diagramId,
              r2Key,
              revision,
              createdAt,
              updatedAt,
            ] = bound as [string, string, string, number, string, string];
            rows.push({
              created_at: createdAt,
              diagram_id: diagramId,
              publication_revision: revision,
              r2_object_key: r2Key,
              revoked_at: null,
              token_digest: tokenDigest,
              updated_at: updatedAt,
            });
          } else if (
            sql.startsWith("UPDATE diagram_shares SET r2_object_key")
          ) {
            const [r2Key, revision, updatedAt, tokenDigest] = bound as [
              string,
              number,
              string,
              string,
            ];
            const row = rows.find((r) => r.token_digest === tokenDigest);
            if (row) {
              row.r2_object_key = r2Key;
              row.publication_revision = revision;
              row.updated_at = updatedAt;
            }
          } else if (sql.startsWith("UPDATE diagram_shares SET revoked_at")) {
            const [revokedAt, tokenDigest] = bound as [string, string];
            const row = rows.find(
              (r) => r.token_digest === tokenDigest && r.revoked_at === null,
            );
            if (row) {
              row.revoked_at = revokedAt;
            }
          } else {
            throw new Error(`Unhandled statement in fake D1: ${sql}`);
          }
          return {
            meta: {
              changed_db: true,
              changes: 1,
              duration: 0,
              last_row_id: 0,
              rows_read: 0,
              rows_written: 1,
              size_after: 0,
            },
            results: [],
            success: true,
          };
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  };
}

/** A minimal in-memory R2 double enforcing the same `If-None-Match: *` create-only semantics. */
function fakeBucket(): {
  bucket: Pick<R2Bucket, "put">;
  objects: Map<string, string>;
} {
  const objects = new Map<string, string>();
  const put = async (
    key: string,
    value: unknown,
    options?: { onlyIf?: R2Conditional | Headers },
  ): Promise<R2Object | null> => {
    const onlyIf = options?.onlyIf;
    const createOnly =
      onlyIf instanceof Headers && onlyIf.get("If-None-Match") === "*";
    if (createOnly && objects.has(key)) {
      return null;
    }
    objects.set(key, String(value));
    return {} as R2Object;
  };
  return {
    bucket: { put } as unknown as Pick<R2Bucket, "put">,
    objects,
  };
}

/** A minimal in-memory KV double. */
function fakeKv(): {
  kv: Pick<KVNamespace, "put" | "delete">;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    kv: {
      async delete(key) {
        store.delete(key);
      },
      async put(key, value) {
        store.set(key, String(value));
      },
    },
    store,
  };
}

const document: GraphDocument = {
  edges: [],
  nodes: [],
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
};

describe("ShareRepository", () => {
  it("generates a fresh token on first publish and writes matching D1/KV/R2 state", async () => {
    const database = fakeDatabase();
    const { bucket, objects } = fakeBucket();
    const { kv, store } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    const result = await repository.publish("diagram-1", "Title", 3, document);

    expect(result.token).not.toBeNull();
    expect(result.revision).toBe(3);
    expect(objects.has("snapshots/diagram-1/3.json")).toBe(true);
    expect(store.size).toBe(1);

    const status = await repository.getStatus("diagram-1");
    expect(status).toMatchObject({ published: true, revision: 3 });
  });

  it("reuses the existing token digest on republish, returning no new raw token", async () => {
    const database = fakeDatabase();
    const { bucket, objects } = fakeBucket();
    const { kv, store } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    const first = await repository.publish("diagram-1", "Title", 1, document);
    const [firstKvKey] = [...store.keys()];

    const second = await repository.publish("diagram-1", "Title", 2, document);

    expect(second.token).toBeNull();
    expect(first.token).not.toBeNull();
    expect(objects.has("snapshots/diagram-1/1.json")).toBe(true);
    expect(objects.has("snapshots/diagram-1/2.json")).toBe(true);
    // The republish updates the same KV entry (same digest key) to point at the new object.
    expect(store.size).toBe(1);
    expect(store.get(firstKvKey)).toBe("snapshots/diagram-1/2.json");

    const status = await repository.getStatus("diagram-1");
    expect(status.revision).toBe(2);
  });

  it("republishing the exact same diagram/revision with no intervening edit is a harmless no-op, never a conflict", async () => {
    const database = fakeDatabase();
    const { bucket, objects } = fakeBucket();
    const { kv } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    await repository.publish("diagram-1", "Title", 1, document);
    // Clicking "republish" again with no edit in between must succeed silently — the
    // revision-addressed key is identical, so this is not the concurrent-write race the
    // create-only R2 guard exists for; it is ruled out before that guard is ever reached.
    await expect(
      repository.publish("diagram-1", "Title", 1, document),
    ).resolves.toEqual({ revision: 1, token: null });
    expect(objects.size).toBe(1);
  });

  it("rejects a genuinely concurrent publish that races to the same key before D1 reflects it", async () => {
    const database = fakeDatabase();
    const { bucket, objects } = fakeBucket();
    const { kv } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    // Simulate a race: the R2 object for diagram-1/revision-1 already exists (another request's
    // write already landed), but this diagram has no active D1 row yet (that request's D1 write
    // has not landed). This is the one case the create-only guard is actually for.
    objects.set("snapshots/diagram-1/1.json", "{}");
    await expect(
      repository.publish("diagram-1", "Title", 1, document),
    ).rejects.toThrow(/already been published/u);
  });

  it("revokes an active share, removing its KV entry and marking D1 revoked", async () => {
    const database = fakeDatabase();
    const { bucket } = fakeBucket();
    const { kv, store } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    await repository.publish("diagram-1", "Title", 1, document);
    expect(store.size).toBe(1);

    await repository.revoke("diagram-1");

    expect(store.size).toBe(0);
    const status = await repository.getStatus("diagram-1");
    expect(status).toEqual({ published: false });
  });

  it("revoking a diagram with no active share is a harmless no-op", async () => {
    const database = fakeDatabase();
    const { bucket } = fakeBucket();
    const { kv } = fakeKv();
    const repository = new ShareRepository(database, bucket, kv);

    await expect(repository.revoke("never-published")).resolves.toBeUndefined();
    expect(await repository.getStatus("never-published")).toEqual({
      published: false,
    });
  });
});
