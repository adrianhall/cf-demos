import { NullError } from "@adrianhall/cloudflare-toolkit/errors";
import { describe, expect, it } from "vitest";
import {
  createOrGetReviewRun,
  getReviewRunById,
  getReviewRunDetail,
  listReviewRuns,
  markRunCompleted,
  markRunFailed,
  recordFetchDiffOutcome,
} from "./reviewRuns";

/** Standard D1 `.run()`/`.all()` metadata shape, reused across every fake statement below. */
const STANDARD_META = {
  changed_db: false,
  changes: 0,
  duration: 0,
  last_row_id: 0,
  rows_read: 0,
  rows_written: 0,
  size_after: 0,
};

/** A recorded D1 statement used to verify this repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

const ROW = {
  id: "run-1",
  workflow_instance_id: null,
  provider: "github",
  repo_full_name: "octo-org/octo-repo",
  pr_number: 42,
  pr_url: "https://github.com/octo-org/octo-repo/pull/42",
  pr_title: "Add a feature",
  pr_author: "octocat",
  head_sha: "abc123",
  trigger: "webhook",
  triggered_by_email: null,
  status: "running",
  diff_truncated: 0,
  changed_file_count: 3,
  comment_url: null,
  error_detail: null,
  created_at: "2026-01-01T00:00:00.000Z",
  completed_at: null,
};

const INPUT = {
  id: "run-1",
  provider: "github" as const,
  repoFullName: "octo-org/octo-repo",
  prNumber: 42,
  prUrl: "https://github.com/octo-org/octo-repo/pull/42",
  prTitle: "Add a feature",
  prAuthor: "octocat",
  headSha: "abc123",
  trigger: "webhook" as const,
  triggeredByEmail: null,
  diffTruncated: false,
  changedFileCount: 3,
};

/**
 * Build a minimal D1 double. `insertReturns` controls the `INSERT ... RETURNING` statement's
 * `first()` result (the row on success, `null` on a reported conflict); `selectReturns`
 * controls the fallback `SELECT`'s result, only ever consulted after a reported conflict.
 * Mirrors `demos/agentic-ai-chat/src/worker/users/repository.test.ts`'s own fake D1 shape.
 */
function databaseFor(
  insertReturns: Record<string, unknown> | null,
  selectReturns: Record<string, unknown> | null = null,
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
          results: [] as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() =>
          (sql.includes("INSERT INTO review_runs")
            ? insertReturns
            : selectReturns) as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
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
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("createOrGetReviewRun", () => {
  it("inserts and returns a newly created run when there is no conflict", async () => {
    const { database, statements } = databaseFor(ROW);

    const result = await createOrGetReviewRun(database, INPUT);

    expect(result.created).toBe(true);
    expect(result.run).toEqual({
      id: "run-1",
      workflowInstanceId: null,
      provider: "github",
      repoFullName: "octo-org/octo-repo",
      prNumber: 42,
      prUrl: "https://github.com/octo-org/octo-repo/pull/42",
      prTitle: "Add a feature",
      prAuthor: "octocat",
      headSha: "abc123",
      trigger: "webhook",
      triggeredByEmail: null,
      status: "running",
      diffTruncated: false,
      changedFileCount: 3,
      commentUrl: null,
      errorDetail: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
    });
    // Only the INSERT ran -- the fallback SELECT must never execute on the non-conflict path.
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain(
      "ON CONFLICT (provider, repo_full_name, pr_number, head_sha) DO NOTHING",
    );
    expect(statements[0]?.sql).toContain("RETURNING");
    expect(statements[0]?.parameters).toEqual([
      "run-1",
      "github",
      "octo-org/octo-repo",
      42,
      "https://github.com/octo-org/octo-repo/pull/42",
      "Add a feature",
      "octocat",
      "abc123",
      "webhook",
      null,
      0,
      3,
    ]);
  });

  it("returns the existing run via a fallback SELECT when the INSERT conflicts", async () => {
    const existingRow = { ...ROW, id: "run-existing" };
    const { database, statements } = databaseFor(null, existingRow);

    const result = await createOrGetReviewRun(database, INPUT);

    expect(result.created).toBe(false);
    expect(result.run.id).toBe("run-existing");
    expect(statements).toHaveLength(2);
    expect(statements[1]?.sql).toContain("SELECT");
    expect(statements[1]?.sql).toContain("FROM review_runs");
    expect(statements[1]?.parameters).toEqual([
      "github",
      "octo-org/octo-repo",
      42,
      "abc123",
    ]);
  });

  it("encodes diffTruncated as an integer for D1's CHECK-less boolean column", async () => {
    const { database, statements } = databaseFor({ ...ROW, diff_truncated: 1 });

    const result = await createOrGetReviewRun(database, {
      ...INPUT,
      diffTruncated: true,
    });

    expect(result.run.diffTruncated).toBe(true);
    expect(statements[0]?.parameters.at(-2)).toBe(1);
  });

  it("throws a defensive guard error if a conflict is reported but the fallback SELECT still finds no row", async () => {
    const { database } = databaseFor(null, null);

    await expect(createOrGetReviewRun(database, INPUT)).rejects.toThrow(
      NullError,
    );
  });
});

/** A minimal D1 double for the plain-`UPDATE`/`SELECT` helpers below -- these don't need the
 * `RETURNING`-aware branching {@link databaseFor} provides for `createOrGetReviewRun`. */
function simpleDatabaseFor(
  selectReturns: Record<string, unknown> | null = null,
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
        first: async <T>() => selectReturns as T | null,
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

describe("getReviewRunById", () => {
  it("returns null when no row matches", async () => {
    const { database } = simpleDatabaseFor(null);

    expect(await getReviewRunById(database, "missing")).toBeNull();
  });

  it("maps a matching row", async () => {
    const { database } = simpleDatabaseFor(ROW);

    const run = await getReviewRunById(database, "run-1");

    expect(run?.id).toBe("run-1");
  });
});

describe("recordFetchDiffOutcome", () => {
  it("updates workflow_instance_id, diff_truncated, and changed_file_count", async () => {
    const { database, statements } = simpleDatabaseFor();

    await recordFetchDiffOutcome(database, "run-1", {
      workflowInstanceId: "wf-1",
      diffTruncated: true,
      changedFileCount: 7,
    });

    expect(statements[0]?.sql).toContain("UPDATE review_runs");
    expect(statements[0]?.parameters).toEqual(["wf-1", 1, 7, "run-1"]);
  });

  it("encodes a non-truncated diff as 0", async () => {
    const { database, statements } = simpleDatabaseFor();

    await recordFetchDiffOutcome(database, "run-1", {
      workflowInstanceId: "wf-1",
      diffTruncated: false,
      changedFileCount: 2,
    });

    expect(statements[0]?.parameters).toEqual(["wf-1", 0, 2, "run-1"]);
  });
});

describe("markRunCompleted", () => {
  it("sets status, comment_url, full_report, and completed_at", async () => {
    const { database, statements } = simpleDatabaseFor();

    await markRunCompleted(database, "run-1", {
      commentUrl: "https://github.com/o/r/pull/1#comment",
      fullReport: "# Report",
    });

    expect(statements[0]?.sql).toContain("status = 'completed'");
    expect(statements[0]?.parameters).toEqual([
      "https://github.com/o/r/pull/1#comment",
      "# Report",
      "run-1",
    ]);
  });
});

describe("markRunFailed", () => {
  it("sets status, error_detail, and completed_at", async () => {
    const { database, statements } = simpleDatabaseFor();

    await markRunFailed(database, "run-1", "fetch-diff exhausted its retries");

    expect(statements[0]?.sql).toContain("status = 'failed'");
    expect(statements[0]?.parameters).toEqual([
      "fetch-diff exhausted its retries",
      "run-1",
    ]);
  });
});

/** A fake D1 double for {@link listReviewRuns}: the joined/aggregated page query responds via
 * `.all()`, the separate `COUNT(*)` query responds via `.first()`, distinguished by SQL text. */
function fakeListRunsDatabase(
  runs: Record<string, unknown>[],
  total: number,
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
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        all: async <T>() => ({
          meta: STANDARD_META,
          results: runs as T[],
          success: true as const,
        }),
        first: async <T>() => ({ count: total }) as T,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: STANDARD_META,
          results: [] as T[],
          success: true as const,
        }),
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;
  return { database, statements };
}

const RUN_SUMMARY_ROW = {
  id: "run-1",
  provider: "github",
  repo_full_name: "octo-org/octo-repo",
  pr_number: 42,
  pr_title: "Add a feature",
  status: "completed",
  total_cost_usd: 0.0123,
  created_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:05:00.000Z",
};

describe("listReviewRuns", () => {
  it("maps every row and returns the total count", async () => {
    const { database, statements } = fakeListRunsDatabase([RUN_SUMMARY_ROW], 1);

    const result = await listReviewRuns(database, { page: 1, pageSize: 20 });

    expect(result).toEqual({
      runs: [
        {
          id: "run-1",
          provider: "github",
          repoFullName: "octo-org/octo-repo",
          prNumber: 42,
          prTitle: "Add a feature",
          status: "completed",
          totalCostUsd: 0.0123,
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
        },
      ],
      total: 1,
    });
    // page 1 -> offset 0, LIMIT pageSize
    expect(statements[0]?.sql).toContain("LEFT JOIN review_reviewers");
    expect(statements[0]?.sql).toContain("GROUP BY r.id");
    expect(statements[0]?.parameters).toEqual([20, 0]);
  });

  it("surfaces a null total cost when no reviewer has a confirmed cost yet", async () => {
    const { database } = fakeListRunsDatabase(
      [{ ...RUN_SUMMARY_ROW, total_cost_usd: null }],
      1,
    );

    const result = await listReviewRuns(database, { page: 1, pageSize: 20 });

    expect(result.runs[0]?.totalCostUsd).toBeNull();
  });

  it("computes the correct OFFSET for a later page", async () => {
    const { database, statements } = fakeListRunsDatabase([], 0);

    await listReviewRuns(database, { page: 3, pageSize: 10 });

    expect(statements[0]?.parameters).toEqual([10, 20]);
  });

  it("clamps a page below 1 up to 1", async () => {
    const { database, statements } = fakeListRunsDatabase([], 0);

    await listReviewRuns(database, { page: 0, pageSize: 20 });

    expect(statements[0]?.parameters).toEqual([20, 0]);
  });

  it("clamps pageSize to at most 100", async () => {
    const { database, statements } = fakeListRunsDatabase([], 0);

    await listReviewRuns(database, { page: 1, pageSize: 500 });

    expect(statements[0]?.parameters).toEqual([100, 0]);
  });

  it("clamps pageSize to at least 1", async () => {
    const { database, statements } = fakeListRunsDatabase([], 0);

    await listReviewRuns(database, { page: 1, pageSize: 0 });

    expect(statements[0]?.parameters).toEqual([1, 0]);
  });

  it("returns an empty page and zero total when there are no runs", async () => {
    const { database } = fakeListRunsDatabase([], 0);

    const result = await listReviewRuns(database, { page: 1, pageSize: 20 });

    expect(result).toEqual({ runs: [], total: 0 });
  });
});

/** A fake D1 double for {@link getReviewRunDetail}: the run-row query responds via `.first()`
 * (matched by `full_report` appearing only in that one SELECT), and the reviewer/findings
 * queries respond via `.all()`, distinguished by which table their `FROM` clause names. */
function fakeRunDetailDatabase(options: {
  runRow: Record<string, unknown> | null;
  reviewerRows?: Record<string, unknown>[];
  findingRows?: Record<string, unknown>[];
}): Pick<D1Database, "prepare"> {
  const reviewerRows = options.reviewerRows ?? [];
  const findingRows = options.findingRows ?? [];
  return {
    prepare(sql: string) {
      const statement = {
        bind(..._parameters: unknown[]) {
          return statement;
        },
        first: async <T>() =>
          (sql.includes("full_report") ? options.runRow : null) as T | null,
        all: async <T>() => {
          if (sql.includes("FROM review_reviewers")) {
            return {
              meta: STANDARD_META,
              results: reviewerRows as T[],
              success: true as const,
            };
          }
          if (sql.includes("FROM review_findings")) {
            return {
              meta: STANDARD_META,
              results: findingRows as T[],
              success: true as const,
            };
          }
          return {
            meta: STANDARD_META,
            results: [] as T[],
            success: true as const,
          };
        },
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: STANDARD_META,
          results: [] as T[],
          success: true as const,
        }),
      };
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;
}

const DETAIL_RUN_ROW = { ...ROW, full_report: "# Report" };

describe("getReviewRunDetail", () => {
  it("returns null when no run matches", async () => {
    const database = fakeRunDetailDatabase({ runRow: null });

    expect(await getReviewRunDetail(database, "missing")).toBeNull();
  });

  it("assembles the run, reviewers (with a re-derived finding count), and findings", async () => {
    const rawOutputWithTwoFindings =
      "Some prose.\n\n```json\n" +
      JSON.stringify([
        {
          findingRef: "CODE-001",
          severity: "medium",
          category: "TypeScript",
          filePath: "src/index.ts",
          lineNumber: 10,
          finding: "Uses any",
          recommendation: "Add a real type",
        },
        {
          findingRef: "CODE-002",
          severity: "low",
          category: "Style",
          filePath: "src/index.ts",
          lineNumber: 20,
          finding: "Inconsistent naming",
          recommendation: "Rename",
        },
      ]) +
      "\n```";
    const database = fakeRunDetailDatabase({
      runRow: DETAIL_RUN_ROW,
      reviewerRows: [
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
          raw_output: rawOutputWithTwoFindings,
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
      ],
      findingRows: [
        {
          finding_ref: "CODE-001",
          priority: "P2",
          severity: "medium",
          category: "TypeScript",
          file_path: "src/index.ts",
          line_number: 10,
          finding: "Uses any",
          recommendation: "Add a real type",
          merged_from: null,
        },
      ],
    });

    const detail = await getReviewRunDetail(database, "run-1");

    expect(detail?.run.id).toBe("run-1");
    expect(detail?.run.fullReport).toBe("# Report");
    expect(detail?.reviewers).toEqual([
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
        findingCount: 2,
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
        findingCount: 0,
      },
    ]);
    expect(detail?.findings).toEqual([
      {
        findingRef: "CODE-001",
        priority: "P2",
        severity: "medium",
        category: "TypeScript",
        filePath: "src/index.ts",
        lineNumber: 10,
        finding: "Uses any",
        recommendation: "Add a real type",
        mergedFrom: null,
      },
    ]);
  });

  it("reports a zero finding count, rather than throwing, when a done reviewer's raw output fails to re-parse", async () => {
    const database = fakeRunDetailDatabase({
      runRow: DETAIL_RUN_ROW,
      reviewerRows: [
        {
          role: "security",
          model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
          status: "done",
          skipped_reason: null,
          error_detail: null,
          cost_usd: 0.002,
          tokens_in: 800,
          tokens_out: 300,
          cost_source: "gateway",
          raw_output: "No fenced JSON block here at all.",
        },
      ],
    });

    const detail = await getReviewRunDetail(database, "run-1");

    expect(detail?.reviewers[0]?.findingCount).toBe(0);
  });

  it("reports a zero finding count for an error reviewer with no raw output", async () => {
    const database = fakeRunDetailDatabase({
      runRow: DETAIL_RUN_ROW,
      reviewerRows: [
        {
          role: "architecture",
          model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
          status: "error",
          skipped_reason: null,
          error_detail: "JSON invalid after repair retry",
          cost_usd: null,
          tokens_in: null,
          tokens_out: null,
          cost_source: "pending",
          raw_output: null,
        },
      ],
    });

    const detail = await getReviewRunDetail(database, "run-1");

    expect(detail?.reviewers[0]?.findingCount).toBe(0);
  });
});
