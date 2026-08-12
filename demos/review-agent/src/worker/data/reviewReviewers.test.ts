import { describe, expect, it } from "vitest";
import {
  listReviewerExecutions,
  listReviewReviewers,
  reconcileReviewerCost,
  upsertReviewReviewer,
} from "./reviewReviewers";

interface RecordedStatement {
  sql: string;
  parameters: unknown[];
}

function databaseFor(allResults: Record<string, unknown>[] = []): {
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
            rows_read: allResults.length,
            rows_written: 0,
            size_after: 0,
          },
          results: allResults as T[],
          success: true as const,
        }),
        first: async <T>() => (allResults[0] ?? null) as T | null,
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

describe("upsertReviewReviewer", () => {
  it("issues an upsert keyed on (run_id, role)", async () => {
    const { database, statements } = databaseFor();

    await upsertReviewReviewer(database, {
      runId: "run-1",
      role: "code-quality",
      status: "done",
      model: "@cf/ibm-granite/granite-4.0-h-micro",
      skippedReason: null,
      errorDetail: null,
      aiGatewayLogId: "log-1",
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      costSource: "pending",
      rawOutput: "Some prose.",
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain(
      "ON CONFLICT (run_id, role) DO UPDATE",
    );
    expect(statements[0]?.parameters).toContain("run-1");
    expect(statements[0]?.parameters).toContain("code-quality");
    expect(statements[0]?.parameters).toContain("Some prose.");
  });
});

describe("reconcileReviewerCost", () => {
  it("updates cost_usd, tokens_in, tokens_out, and flips cost_source to gateway", async () => {
    const { database, statements } = databaseFor();

    await reconcileReviewerCost(database, "run-1", "security", {
      costUsd: 0.0042,
      tokensIn: 100,
      tokensOut: 50,
    });

    expect(statements[0]?.sql).toContain("cost_source = 'gateway'");
    expect(statements[0]?.parameters).toEqual([
      0.0042,
      100,
      50,
      "run-1",
      "security",
    ]);
  });
});

describe("listReviewReviewers", () => {
  it("maps every row's snake_case columns to camelCase", async () => {
    const { database } = databaseFor([
      {
        role: "code-quality",
        model: "@cf/ibm-granite/granite-4.0-h-micro",
        status: "done",
        skipped_reason: null,
        error_detail: null,
        raw_output: "Prose.",
      },
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skipped_reason: "No UI-relevant changed file.",
        error_detail: null,
        raw_output: null,
      },
    ]);

    const rows = await listReviewReviewers(database, "run-1");

    expect(rows).toEqual([
      {
        role: "code-quality",
        model: "@cf/ibm-granite/granite-4.0-h-micro",
        status: "done",
        skippedReason: null,
        errorDetail: null,
        rawOutput: "Prose.",
      },
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skippedReason: "No UI-relevant changed file.",
        errorDetail: null,
        rawOutput: null,
      },
    ]);
  });

  it("returns an empty array when the run has no reviewer rows yet", async () => {
    const { database } = databaseFor([]);

    expect(await listReviewReviewers(database, "run-1")).toEqual([]);
  });
});

describe("listReviewerExecutions", () => {
  it("maps every row's snake_case columns to camelCase, including cost/token figures", async () => {
    const { database, statements } = databaseFor([
      {
        role: "code-quality",
        model: "@cf/ibm-granite/granite-4.0-h-micro",
        status: "done",
        skipped_reason: null,
        error_detail: null,
        cost_usd: 0.001,
        tokens_in: 500,
        tokens_out: 200,
        cost_source: "gateway",
        raw_output: "Prose.",
      },
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skipped_reason: "No UI-relevant changed file.",
        error_detail: null,
        cost_usd: null,
        tokens_in: null,
        tokens_out: null,
        cost_source: "pending",
        raw_output: null,
      },
    ]);

    const rows = await listReviewerExecutions(database, "run-1");

    expect(rows).toEqual([
      {
        role: "code-quality",
        model: "@cf/ibm-granite/granite-4.0-h-micro",
        status: "done",
        skippedReason: null,
        errorDetail: null,
        costUsd: 0.001,
        tokensIn: 500,
        tokensOut: 200,
        costSource: "gateway",
        rawOutput: "Prose.",
      },
      {
        role: "accessibility",
        model: null,
        status: "skipped",
        skippedReason: "No UI-relevant changed file.",
        errorDetail: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        costSource: "pending",
        rawOutput: null,
      },
    ]);
    expect(statements[0]?.sql).toContain(
      "FROM review_reviewers WHERE run_id = ?",
    );
    expect(statements[0]?.parameters).toEqual(["run-1"]);
  });

  it("returns an empty array when the run has no reviewer rows yet", async () => {
    const { database } = databaseFor([]);

    expect(await listReviewerExecutions(database, "run-1")).toEqual([]);
  });
});
