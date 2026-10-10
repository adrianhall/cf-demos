import { describe, expect, it } from "vitest";
import { SkillsRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Extra, per-test-case configuration for {@link databaseFor}'s fake `run()`/`all()` results. */
interface DatabaseForOptions {
  /** Rows `all()` resolves with. Defaults to no rows. */
  selectRows?: Record<string, unknown>[];
  /** `meta.changes` `run()` resolves with. Defaults to `1`. */
  changes?: number;
}

/** Build a minimal D1 double whose `first()` returns `selectRow` for the repository's
 * `SELECT` -- mirrors `../chats/repository.test.ts`'s own fake D1 shape. */
function databaseFor(
  selectRow: Record<string, unknown> | null,
  options: DatabaseForOptions = {},
): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const database = {
    prepare(sql: string) {
      const record: RecordedStatement = { parameters: [], sql };
      statements.push(record);
      const statement = {
        all: async <T>() => ({
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 0,
            size_after: 0,
          },
          results: (options.selectRows ?? []) as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() => selectRow as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: {
            changed_db: false,
            changes: options.changes ?? 1,
            duration: 0,
            last_row_id: 0,
            rows_read: 0,
            rows_written: 1,
            size_after: 0,
          },
          results: [] as T[],
          success: true as const,
        }),
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

/** A raw `skills` row fixture, in D1's own snake-cased column shape. */
function skillRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "skill-1",
    owner_email: null,
    name: "cloudflare-spike-fact",
    source_type: "upload",
    source_ref: null,
    r2_key: "skills/enterprise/skill-1",
    created_at: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("SkillsRepository", () => {
  it("creates a new enterprise skill row carrying every field the caller supplied", async () => {
    const { database, statements } = databaseFor(null);

    const skill = await new SkillsRepository(database).create({
      id: "skill-1",
      ownerEmail: null,
      name: "cloudflare-spike-fact",
      sourceType: "upload",
      sourceRef: null,
      r2Key: "skills/enterprise/skill-1",
    });

    expect(skill).toMatchObject({
      id: "skill-1",
      ownerEmail: null,
      name: "cloudflare-spike-fact",
      sourceType: "upload",
      sourceRef: null,
      r2Key: "skills/enterprise/skill-1",
    });
    expect(skill.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(statements[0]).toMatchObject({
      parameters: [
        "skill-1",
        null,
        "cloudflare-spike-fact",
        "upload",
        null,
        "skills/enterprise/skill-1",
        skill.createdAt,
      ],
      sql: expect.stringContaining("INSERT INTO skills"),
    });
  });

  it("creates a new personal skill row with its owner_email set", async () => {
    const { database } = databaseFor(null);

    const skill = await new SkillsRepository(database).create({
      id: "skill-1",
      ownerEmail: "alice@example.com",
      name: "trip-planner",
      sourceType: "url",
      sourceRef: "https://example.com/skill.md",
      r2Key: "skills/personal/alice@example.com/skill-1",
    });

    expect(skill).toMatchObject({ ownerEmail: "alice@example.com" });
  });

  it("lists enterprise skills, mapping every row's owner_email back to null", async () => {
    const { database, statements } = databaseFor(null, {
      selectRows: [skillRow()],
    });

    const skills = await new SkillsRepository(database).listEnterprise();

    expect(skills).toEqual([
      {
        id: "skill-1",
        ownerEmail: null,
        name: "cloudflare-spike-fact",
        sourceType: "upload",
        sourceRef: null,
        r2Key: "skills/enterprise/skill-1",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    expect(statements[0]?.sql).toContain("owner_email IS NULL");
  });

  it("lists a specific owner's personal skills", async () => {
    const { database, statements } = databaseFor(null, {
      selectRows: [
        skillRow({
          owner_email: "alice@example.com",
          r2_key: "skills/personal/alice@example.com/skill-1",
        }),
      ],
    });

    const skills = await new SkillsRepository(database).listPersonal(
      "alice@example.com",
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]?.ownerEmail).toBe("alice@example.com");
    expect(statements[0]).toMatchObject({
      parameters: ["alice@example.com"],
      sql: expect.stringContaining("WHERE owner_email = ?"),
    });
  });

  it("coerces an unrecognized stored source_type back to upload", async () => {
    const { database } = databaseFor(null, {
      selectRows: [skillRow({ source_type: "something-else" })],
    });

    const [skill] = await new SkillsRepository(database).listEnterprise();

    expect(skill?.sourceType).toBe("upload");
  });

  it("maps a stored url source_type through unchanged", async () => {
    const { database } = databaseFor(null, {
      selectRows: [
        skillRow({
          source_type: "url",
          source_ref: "https://example.com/skill.md",
        }),
      ],
    });

    const [skill] = await new SkillsRepository(database).listEnterprise();

    expect(skill?.sourceType).toBe("url");
  });

  describe("findByNameInScope", () => {
    it("scopes to owner_email IS NULL for an enterprise lookup", async () => {
      const { database, statements } = databaseFor(skillRow());

      const skill = await new SkillsRepository(database).findByNameInScope(
        null,
        "cloudflare-spike-fact",
      );

      expect(skill).not.toBeNull();
      expect(statements[0]).toMatchObject({
        parameters: ["cloudflare-spike-fact"],
        sql: expect.stringContaining("owner_email IS NULL AND name = ?"),
      });
    });

    it("scopes to a specific owner for a personal lookup", async () => {
      const { database, statements } = databaseFor(null);

      await new SkillsRepository(database).findByNameInScope(
        "alice@example.com",
        "trip-planner",
      );

      expect(statements[0]).toMatchObject({
        parameters: ["alice@example.com", "trip-planner"],
        sql: expect.stringContaining("WHERE owner_email = ? AND name = ?"),
      });
    });

    it("returns null when no skill has this name in this scope", async () => {
      const { database } = databaseFor(null);

      const skill = await new SkillsRepository(database).findByNameInScope(
        null,
        "unused-name",
      );

      expect(skill).toBeNull();
    });
  });

  it("finds a personal skill scoped to its owner", async () => {
    const { database, statements } = databaseFor(
      skillRow({ owner_email: "alice@example.com" }),
    );

    const skill = await new SkillsRepository(database).findPersonalOwned(
      "skill-1",
      "alice@example.com",
    );

    expect(skill?.ownerEmail).toBe("alice@example.com");
    expect(statements[0]).toMatchObject({
      parameters: ["skill-1", "alice@example.com"],
      sql: expect.stringContaining("WHERE id = ? AND owner_email = ?"),
    });
  });

  it("returns null for a personal skill owned by a different identity", async () => {
    const { database } = databaseFor(null);

    const skill = await new SkillsRepository(database).findPersonalOwned(
      "skill-1",
      "bob@example.com",
    );

    expect(skill).toBeNull();
  });

  it("finds an enterprise skill by id", async () => {
    const { database, statements } = databaseFor(skillRow());

    const skill = await new SkillsRepository(database).findEnterprise(
      "skill-1",
    );

    expect(skill).not.toBeNull();
    expect(statements[0]).toMatchObject({
      parameters: ["skill-1"],
      sql: expect.stringContaining("owner_email IS NULL"),
    });
  });

  it("removes a personal skill scoped to its owner and reports success", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });

    const removed = await new SkillsRepository(database).removePersonal(
      "skill-1",
      "alice@example.com",
    );

    expect(removed).toBe(true);
    expect(statements[0]).toMatchObject({
      parameters: ["skill-1", "alice@example.com"],
      sql: expect.stringContaining("DELETE FROM skills"),
    });
  });

  it("reports failure removing a personal skill that does not belong to the caller", async () => {
    const { database } = databaseFor(null, { changes: 0 });

    const removed = await new SkillsRepository(database).removePersonal(
      "skill-1",
      "bob@example.com",
    );

    expect(removed).toBe(false);
  });

  it("removes an enterprise skill and reports success", async () => {
    const { database, statements } = databaseFor(null, { changes: 1 });

    const removed = await new SkillsRepository(database).removeEnterprise(
      "skill-1",
    );

    expect(removed).toBe(true);
    expect(statements[0]?.sql).toContain("owner_email IS NULL");
  });
});
