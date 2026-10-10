import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it, vi } from "vitest";
import { createSkill, removeSkillAndCleanup } from "./service";
import type { Skill } from "./types";

/** Assert that `fn` rejects with a {@link ProblemDetailsError} with the given HTTP status. */
async function expectProblem(
  fn: () => Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await fn();
    expect.unreachable("expected fn to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject({
      status,
    });
  }
}

/** A minimal D1 double whose `SELECT ... name = ?` (the duplicate-name guard) resolves to
 * `existingRow`, and whose `INSERT` either succeeds or rejects with `insertError`. */
function databaseFor(
  existingRow: Record<string, unknown> | null,
  insertError: Error | null = null,
): Pick<D1Database, "prepare"> {
  return {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        first: async <T>() => existingRow as T | null,
        run: async () => {
          if (sql.includes("INSERT") && insertError) {
            throw insertError;
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
            success: true as const,
          };
        },
      };
      return statement;
    },
    // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real D1Database interface.
  } as any;
}

describe("createSkill", () => {
  it("writes the built SKILL.md to R2 and persists a catalog row", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;

    const skill = await createSkill(
      { bucket, database: databaseFor(null) },
      null,
      {
        name: "cloudflare-spike-fact",
        description: "Use whenever the user asks for the spike passphrase.",
        source: { type: "upload", content: "Fetch the passphrase." },
      },
    );

    expect(skill).toMatchObject({
      ownerEmail: null,
      name: "cloudflare-spike-fact",
      sourceType: "upload",
      sourceRef: null,
    });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, markdown] = put.mock.calls[0] as [string, string];
    expect(key).toContain(`skills/enterprise/${skill.id}/SKILL.md`);
    expect(markdown).toContain('name: "cloudflare-spike-fact"');
    expect(markdown).toContain("Fetch the passphrase.");
  });

  it("scopes a personal skill's R2 directory under the owner's own prefix", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;

    const skill = await createSkill(
      { bucket, database: databaseFor(null) },
      "alice@example.com",
      {
        name: "trip-planner",
        description: "Use for trip planning.",
        source: { type: "upload", content: "Plan a trip." },
      },
    );

    expect(skill.ownerEmail).toBe("alice@example.com");
    const [key] = put.mock.calls[0] as [string, string];
    expect(key).toContain("skills/personal/alice@example.com/");
  });

  it("fetches a URL source's body and records the URL as sourceRef", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("# Remote instructions")),
    );

    const skill = await createSkill(
      { bucket, database: databaseFor(null) },
      null,
      {
        name: "remote-skill",
        description: "Fetched from a URL.",
        source: { type: "url", url: "https://example.com/skill.md" },
      },
    );

    expect(skill).toMatchObject({
      sourceType: "url",
      sourceRef: "https://example.com/skill.md",
    });
    vi.unstubAllGlobals();
  });

  it("rejects a request body that is not an object", async () => {
    const bucket = { put: vi.fn() } as unknown as R2Bucket;

    await expectProblem(
      () => createSkill({ bucket, database: databaseFor(null) }, null, null),
      400,
    );
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("rejects a malformed source before ever writing to R2", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;

    await expectProblem(
      () =>
        createSkill({ bucket, database: databaseFor(null) }, null, {
          name: "name",
          description: "description",
          source: { type: "not-a-real-type" },
        }),
      400,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a source that is not an object", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;

    await expectProblem(
      () =>
        createSkill({ bucket, database: databaseFor(null) }, null, {
          name: "name",
          description: "description",
          source: "not an object",
        }),
      400,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a URL source whose url field is not a string", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;

    await expectProblem(
      () =>
        createSkill({ bucket, database: databaseFor(null) }, null, {
          name: "name",
          description: "description",
          source: { type: "url", url: 42 },
        }),
      400,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name within the same scope before ever writing to R2", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;
    const existing = {
      id: "existing",
      owner_email: null,
      name: "cloudflare-spike-fact",
      source_type: "upload",
      source_ref: null,
      r2_key: "skills/enterprise/existing",
      created_at: "2026-08-03T00:00:00.000Z",
    };

    await expectProblem(
      () =>
        createSkill({ bucket, database: databaseFor(existing) }, null, {
          name: "cloudflare-spike-fact",
          description: "description",
          source: { type: "upload", content: "content" },
        }),
      422,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("deletes the now-orphaned R2 directory and rethrows when the D1 insert fails", async () => {
    const deleted: string[][] = [];
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        objects: [{ key: "skills/enterprise/skill-1/SKILL.md" }],
        truncated: false,
      }),
      delete: vi.fn().mockImplementation(async (keys: string[]) => {
        deleted.push(keys);
      }),
    } as unknown as R2Bucket;
    const insertError = new Error("simulated D1 outage");

    await expect(
      createSkill({ bucket, database: databaseFor(null, insertError) }, null, {
        name: "cloudflare-spike-fact",
        description: "description",
        source: { type: "upload", content: "content" },
      }),
    ).rejects.toBe(insertError);
    expect(deleted).toHaveLength(1);
  });
});

describe("removeSkillAndCleanup", () => {
  /** A minimal enterprise skill fixture. */
  function enterpriseSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      id: "skill-1",
      ownerEmail: null,
      name: "cloudflare-spike-fact",
      sourceType: "upload",
      sourceRef: null,
      r2Key: "skills/enterprise/skill-1",
      createdAt: "2026-08-03T00:00:00.000Z",
      ...overrides,
    };
  }

  it("deletes the R2 directory once the enterprise D1 row is actually removed", async () => {
    const list = vi.fn().mockResolvedValue({
      objects: [{ key: "skills/enterprise/skill-1/SKILL.md" }],
      truncated: false,
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const bucket = { list, delete: del } as unknown as R2Bucket;
    const database = {
      prepare() {
        const statement = {
          bind() {
            return statement;
          },
          run: async () => ({
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
            success: true as const,
          }),
        };
        return statement;
      },
      // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real D1Database interface.
    } as any;

    await removeSkillAndCleanup(
      { bucket, database },
      enterpriseSkill(),
      "enterprise",
    );

    expect(del).toHaveBeenCalledWith(["skills/enterprise/skill-1/SKILL.md"]);
  });

  it("never touches R2 when the D1 row was not actually removed (already gone)", async () => {
    const list = vi.fn();
    const del = vi.fn();
    const bucket = { list, delete: del } as unknown as R2Bucket;
    const database = {
      prepare() {
        const statement = {
          bind() {
            return statement;
          },
          run: async () => ({
            meta: {
              changed_db: false,
              changes: 0,
              duration: 0,
              last_row_id: 0,
              rows_read: 0,
              rows_written: 0,
              size_after: 0,
            },
            results: [],
            success: true as const,
          }),
        };
        return statement;
      },
      // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real D1Database interface.
    } as any;

    await removeSkillAndCleanup(
      { bucket, database },
      enterpriseSkill(),
      "enterprise",
    );

    expect(list).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
