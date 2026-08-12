import { describe, expect, it } from "vitest";
import type { MergedFinding } from "../review/merge";
import { listReviewFindings, replaceMergedFindings } from "./reviewFindings";

interface RecordedStatement {
  sql: string;
  parameters: unknown[];
}

function databaseFor(): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  const database = {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, parameters: [] };
      statements.push(record);
      const statement = {
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
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
          results: [] as T[],
          success: true as const,
        }),
        first: async <T>() => null as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
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
  } satisfies Pick<D1Database, "prepare">;
  return { database, statements };
}

const FINDING: MergedFinding = {
  findingRef: "ARCH-001",
  priority: "P1",
  severity: "high",
  category: "API design",
  filePath: "src/index.ts",
  lineNumber: 10,
  finding: "Something",
  recommendation: "Fix it",
  mergedFrom: null,
  role: "architecture",
};

describe("replaceMergedFindings", () => {
  it("deletes existing findings for the run before inserting the new list", async () => {
    const { database, statements } = databaseFor();

    await replaceMergedFindings(database, "run-1", [FINDING]);

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain(
      "DELETE FROM review_findings WHERE run_id = ?",
    );
    expect(statements[0]?.parameters).toEqual(["run-1"]);
    expect(statements[1]?.sql).toContain("INSERT INTO review_findings");
    expect(statements[1]?.parameters).toContain("ARCH-001");
    expect(statements[1]?.parameters).toContain("run-1");
  });

  it("only issues the DELETE when the findings list is empty", async () => {
    const { database, statements } = databaseFor();

    await replaceMergedFindings(database, "run-1", []);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("DELETE");
  });
});

/** A fake D1 double for {@link listReviewFindings}: `.all()` always returns the queued rows,
 * regardless of bound parameters -- this repository function issues exactly one query. */
function findingsDatabaseFor(rows: Record<string, unknown>[]): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  const database = {
    prepare(sql: string) {
      const record: RecordedStatement = { sql, parameters: [] };
      statements.push(record);
      const statement = {
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        all: async <T>() => ({
          meta: {
            changed_db: false,
            changes: 0,
            duration: 0,
            last_row_id: 0,
            rows_read: rows.length,
            rows_written: 0,
            size_after: 0,
          },
          results: rows as T[],
          success: true as const,
        }),
        first: async <T>() => null as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
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
  } satisfies Pick<D1Database, "prepare">;
  return { database, statements };
}

describe("listReviewFindings", () => {
  it("maps every row's snake_case columns to camelCase", async () => {
    const { database, statements } = findingsDatabaseFor([
      {
        finding_ref: "ARCH-001",
        priority: "P1",
        severity: "high",
        category: "API design",
        file_path: "src/index.ts",
        line_number: 10,
        finding: "Something",
        recommendation: "Fix it",
        merged_from: null,
      },
      {
        finding_ref: "SEC-002+",
        priority: "P0",
        severity: "critical",
        category: "Injection",
        file_path: null,
        line_number: null,
        finding: "SQL injection risk",
        recommendation: "Parameterize the query",
        merged_from: "architecture,security",
      },
    ]);

    const rows = await listReviewFindings(database, "run-1");

    expect(rows).toEqual([
      {
        findingRef: "ARCH-001",
        priority: "P1",
        severity: "high",
        category: "API design",
        filePath: "src/index.ts",
        lineNumber: 10,
        finding: "Something",
        recommendation: "Fix it",
        mergedFrom: null,
      },
      {
        findingRef: "SEC-002+",
        priority: "P0",
        severity: "critical",
        category: "Injection",
        filePath: null,
        lineNumber: null,
        finding: "SQL injection risk",
        recommendation: "Parameterize the query",
        mergedFrom: "architecture,security",
      },
    ]);
    expect(statements[0]?.sql).toContain(
      "FROM review_findings WHERE run_id = ?",
    );
    expect(statements[0]?.parameters).toEqual(["run-1"]);
  });

  it("returns an empty array when the run has no findings", async () => {
    const { database } = findingsDatabaseFor([]);

    expect(await listReviewFindings(database, "run-1")).toEqual([]);
  });
});
