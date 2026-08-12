import {
  cloudflareLogger,
  problemDetailsErrorHandler,
} from "@adrianhall/cloudflare-toolkit/hono";
import {
  type CaptureTransport,
  createCaptureTransport,
  type LogLevel,
} from "@adrianhall/cloudflare-toolkit/logging";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../../src/worker/bindings";
import { reviewsRouter } from "../../src/worker/routes/reviews";
import type { ReviewTrigger } from "../../src/worker/review/types";

/**
 * Relocated here (never lived in `src/worker/routes/reviews.test.ts` at all) for the same reason
 * Phase 4 relocated `webhooks.test.ts`: `../../src/worker/review/startRun.ts` -- which this
 * router imports to start a newly created run -- imports `getAgentByName` from the `agents`
 * package, whose own top-level module unconditionally imports `cloudflare:workers`/
 * `cloudflare:email`, which Node's plain ESM loader (the `src/worker/vitest.config.ts` "worker"
 * project's `environment: "node"`) cannot resolve at all. Every fake here (D1, the `REVIEW_RUN`
 * Durable Object namespace, `fetch`) is still hand-built, never a real binding -- this is
 * `@cloudflare/vitest-pool-workers`'s real `workerd` runtime only so `agents`'s own
 * Cloudflare-only imports resolve, not because this suite drives real D1/Durable Object
 * behavior. Pure-logic pieces with no `agents` dependency (URL-provider detection, body/query
 * validation) are unit-tested directly in the `worker` project instead -- see
 * `src/worker/review/detectProvider.test.ts` and `src/worker/review/reviewsValidation.test.ts`.
 */

function findLog(
  transport: CaptureTransport,
  level: LogLevel,
  message: string,
) {
  return transport.find(level).find((record) => record.message === message);
}

/** A recorded D1 statement, and the minimal fake D1 double this route's repository calls need.
 * Mirrors `webhooks.test.ts`'s own `fakeDatabase()` shape. */
function fakeDatabase(options: {
  insertResults?: (Record<string, unknown> | null)[];
  selectResult?: Record<string, unknown> | null;
}): Pick<D1Database, "prepare"> {
  const insertResults = [...(options.insertResults ?? [])];
  const selectResult = options.selectResult ?? null;

  return {
    prepare(sql: string) {
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
        bind(..._parameters: unknown[]) {
          return statement;
        },
        first: async <T>() => {
          if (sql.includes("INSERT INTO review_runs")) {
            return (
              insertResults.length > 0 ? insertResults.shift() : defaultRunRow()
            ) as T | null;
          }
          if (sql.includes("SELECT") && sql.includes("FROM review_runs")) {
            return selectResult as T | null;
          }
          return null as T | null;
        },
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
  };
}

function defaultRunRow(): Record<string, unknown> {
  return {
    id: "generated-run-id",
    workflow_instance_id: null,
    provider: "github",
    repo_full_name: "octo-org/octo-repo",
    pr_number: 42,
    pr_url: "https://github.com/octo-org/octo-repo/pull/42",
    pr_title: "Add a feature",
    pr_author: "octocat",
    head_sha: "fresh-head-sha",
    trigger: "manual",
    triggered_by_email: "reviewer@example.com",
    status: "running",
    diff_truncated: 0,
    changed_file_count: 0,
    comment_url: null,
    error_detail: null,
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
  };
}

/** A minimal fake `REVIEW_RUN` Durable Object namespace, mirroring `webhooks.test.ts`'s own --
 * just enough surface for `getAgentByName()` to resolve a stub and record every `start()` call. */
function fakeReviewRunNamespace(startedPayloads: ReviewTrigger[]) {
  return {
    idFromName(name: string) {
      return { toString: () => name };
    },
    get(_id: unknown) {
      return {
        async setName() {},
        async start(payload: ReviewTrigger) {
          startedPayloads.push(payload);
        },
      };
    },
  };
}

function baseEnv(
  database: Pick<D1Database, "prepare">,
  startedPayloads: ReviewTrigger[] = [],
) {
  return {
    DB: database as unknown as D1Database,
    GITHUB_TOKEN: "token",
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITLAB_TOKEN: "token",
    GITLAB_WEBHOOK_SECRET: "gitlab-secret",
    REVIEW_RUN: fakeReviewRunNamespace(startedPayloads),
  };
}

/** Build a standalone test app mounting only `reviewsRouter`, with a middleware stand-in for
 * `accessMiddleware` (this router's own behavior never depends on the real `cloudflareAccess()`
 * JWT verification, only on the `Cloudflare_Access_Identity` context variable it sets) and a
 * capture-transport logger. */
function buildApp() {
  const transport = createCaptureTransport();
  const app = new Hono<AppBindings>();
  app.use(cloudflareLogger({ transport, level: "trace" }));
  app.use(async (context, next) => {
    context.set("Cloudflare_Access_Identity", {
      source: "header",
      email: "reviewer@example.com",
      sub: "user-123",
    });
    await next();
  });
  app.route("/api/reviews", reviewsRouter);
  app.onError(problemDetailsErrorHandler());
  return { app, transport };
}

/** Stub the global `fetch` for exactly one call -- every `GitProviderClient` implementation
 * resolves its own `fetch` at construction time (`options.fetch ?? fetch`), so this must be in
 * place before the route handler constructs its provider clients. */
function stubFetchOnce(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(String(input)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/reviews", () => {
  it("rejects a body with no url", async () => {
    const database = fakeDatabase({});
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      baseEnv(database),
    );

    expect(response.status).toBe(400);
  });

  it("rejects a url that matches neither provider", async () => {
    const database = fakeDatabase({});
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/not-a-pr" }),
      },
      baseEnv(database),
    );

    expect(response.status).toBe(400);
  });

  it("resolves metadata, creates the run with trigger=manual and the caller's email, and starts the agent", async () => {
    const database = fakeDatabase({ insertResults: [defaultRunRow()] });
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    stubFetchOnce((url) => {
      expect(url).toContain("/repos/octo-org/octo-repo/pulls/42");
      return new Response(
        JSON.stringify({
          head: { sha: "fresh-head-sha" },
          title: "Add a feature",
          user: { login: "octocat" },
          html_url: "https://github.com/octo-org/octo-repo/pull/42",
        }),
        { status: 200 },
      );
    });

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/octo-org/octo-repo/pull/42",
        }),
      },
      baseEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "generated-run-id",
      status: "running",
    });
    expect(findLog(transport, "info", "review_started")).not.toBeUndefined();
    // The exact same run-starting path the webhook route uses (`../review/startRun.ts`), with
    // the resolved (not the empty parsePrUrl()) head SHA.
    expect(startedPayloads).toEqual([
      {
        runId: "generated-run-id",
        ref: expect.objectContaining({
          provider: "github",
          repoFullName: "octo-org/octo-repo",
          prNumber: 42,
          headSha: "fresh-head-sha",
        }),
      },
    ]);
  });

  it("detects a GitLab merge request URL", async () => {
    const database = fakeDatabase({
      insertResults: [{ ...defaultRunRow(), provider: "gitlab" }],
    });
    const startedPayloads: ReviewTrigger[] = [];
    const { app } = buildApp();
    stubFetchOnce((url) => {
      expect(url).toContain(
        "/projects/flightjs%2Fflight-management/merge_requests/16",
      );
      return new Response(
        JSON.stringify({
          sha: "fresh-head-sha",
          title: "Add validation",
          author: { username: "agarcia" },
          web_url:
            "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
        }),
        { status: 200 },
      );
    });

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
        }),
      },
      baseEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    expect(startedPayloads).toEqual([
      {
        runId: "generated-run-id",
        ref: expect.objectContaining({
          provider: "gitlab",
          repoFullName: "flightjs/flight-management",
          prNumber: 16,
          headSha: "fresh-head-sha",
        }),
      },
    ]);
  });

  it("responds 400 without creating a run when the provider lookup fails", async () => {
    const database = fakeDatabase({});
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    stubFetchOnce(() => new Response("not found", { status: 404 }));

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/octo-org/octo-repo/pull/9999",
        }),
      },
      baseEnv(database, startedPayloads),
    );

    expect(response.status).toBe(400);
    expect(startedPayloads).toEqual([]);
    expect(
      findLog(transport, "warn", "manual_trigger_metadata_failed"),
    ).not.toBeUndefined();
  });

  it("does not start the agent when the run already existed (a race with a webhook)", async () => {
    const database = fakeDatabase({
      insertResults: [null],
      selectResult: defaultRunRow(),
    });
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    stubFetchOnce(
      () =>
        new Response(
          JSON.stringify({
            head: { sha: "fresh-head-sha" },
            title: "Add a feature",
            user: { login: "octocat" },
            html_url: "https://github.com/octo-org/octo-repo/pull/42",
          }),
          { status: 200 },
        ),
    );

    const response = await app.request(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/octo-org/octo-repo/pull/42",
        }),
      },
      baseEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    expect(startedPayloads).toEqual([]);
    expect(findLog(transport, "info", "review_started")).toBeUndefined();
  });
});

/** A fake D1 double for the two read-only `GET` routes below -- distinguishes the joined/
 * aggregated history query, the `COUNT(*)` query, the single-run detail query, and the
 * reviewer/findings sub-queries purely by SQL text, mirroring `../../src/worker/data/
 * reviewRuns.test.ts`'s own fakes for the repository functions these routes call. */
function fakeReadDatabase(options: {
  runsPage?: Record<string, unknown>[];
  total?: number;
  runRow?: Record<string, unknown> | null;
  reviewerRows?: Record<string, unknown>[];
  findingRows?: Record<string, unknown>[];
}): Pick<D1Database, "prepare"> {
  const runsPage = options.runsPage ?? [];
  const total = options.total ?? 0;
  const runRow = options.runRow ?? null;
  const reviewerRows = options.reviewerRows ?? [];
  const findingRows = options.findingRows ?? [];

  return {
    prepare(sql: string) {
      const statement = {
        all: async <T>() => {
          if (sql.includes("LEFT JOIN review_reviewers")) {
            return {
              meta: {
                changed_db: false,
                changes: 0,
                duration: 0,
                last_row_id: 0,
                rows_read: runsPage.length,
                rows_written: 0,
                size_after: 0,
              },
              results: runsPage as T[],
              success: true as const,
            };
          }
          if (sql.includes("FROM review_reviewers")) {
            return {
              meta: {
                changed_db: false,
                changes: 0,
                duration: 0,
                last_row_id: 0,
                rows_read: reviewerRows.length,
                rows_written: 0,
                size_after: 0,
              },
              results: reviewerRows as T[],
              success: true as const,
            };
          }
          if (sql.includes("FROM review_findings")) {
            return {
              meta: {
                changed_db: false,
                changes: 0,
                duration: 0,
                last_row_id: 0,
                rows_read: findingRows.length,
                rows_written: 0,
                size_after: 0,
              },
              results: findingRows as T[],
              success: true as const,
            };
          }
          return {
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
          };
        },
        bind(..._parameters: unknown[]) {
          return statement;
        },
        first: async <T>() => {
          if (sql.includes("COUNT(*)")) {
            return { count: total } as T;
          }
          if (sql.includes("full_report")) {
            return runRow as T | null;
          }
          return null as T | null;
        },
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
  };
}

describe("GET /api/reviews", () => {
  it("returns a paginated page of run history", async () => {
    const database = fakeReadDatabase({
      runsPage: [
        {
          id: "run-1",
          provider: "github",
          repo_full_name: "octo-org/octo-repo",
          pr_number: 42,
          pr_title: "Add a feature",
          status: "completed",
          total_cost_usd: 0.01,
          created_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:05:00.000Z",
        },
      ],
      total: 1,
    });
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews?page=1&pageSize=20",
      { method: "GET" },
      baseEnv(database),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runs: [
        {
          id: "run-1",
          provider: "github",
          repoFullName: "octo-org/octo-repo",
          prNumber: 42,
          prTitle: "Add a feature",
          status: "completed",
          totalCostUsd: 0.01,
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  it("rejects an out-of-range pageSize with 400", async () => {
    const database = fakeReadDatabase({});
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews?pageSize=500",
      { method: "GET" },
      baseEnv(database),
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /api/reviews/:id", () => {
  it("returns the full run detail", async () => {
    const database = fakeReadDatabase({
      runRow: {
        id: "run-1",
        workflow_instance_id: "wf-1",
        provider: "github",
        repo_full_name: "octo-org/octo-repo",
        pr_number: 42,
        pr_url: "https://github.com/octo-org/octo-repo/pull/42",
        pr_title: "Add a feature",
        pr_author: "octocat",
        head_sha: "abc123",
        trigger: "webhook",
        triggered_by_email: null,
        status: "completed",
        diff_truncated: 0,
        changed_file_count: 3,
        comment_url: "https://github.com/octo-org/octo-repo/pull/42#comment",
        error_detail: null,
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:05:00.000Z",
        full_report: "# Report",
      },
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
          raw_output: "```json\n[]\n```",
        },
      ],
      findingRows: [],
    });
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews/run-1",
      { method: "GET" },
      baseEnv(database),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string } };
    expect(body.run.id).toBe("run-1");
  });

  it("returns 404 for an unknown run id", async () => {
    const database = fakeReadDatabase({ runRow: null });
    const { app } = buildApp();

    const response = await app.request(
      "/api/reviews/missing",
      { method: "GET" },
      baseEnv(database),
    );

    expect(response.status).toBe(404);
  });
});
