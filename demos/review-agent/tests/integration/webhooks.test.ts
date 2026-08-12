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
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../../src/worker/bindings";
import { hmacSha256Hex } from "../../src/worker/providers/webhook-crypto";
import type { ReviewTrigger } from "../../src/worker/review/types";
import { webhooksRouter } from "../../src/worker/routes/webhooks";

/**
 * Relocated here from `src/worker/routes/webhooks.test.ts` (Phase 3) when Phase 4 wired
 * `handleWebhook()` to `getAgentByName(env.REVIEW_RUN, run.id).start(payload)`
 * (`../../src/worker/routes/webhooks.ts`, item 10): the `agents` package's own top-level module
 * unconditionally imports `cloudflare:workers`/`cloudflare:email`, which Node's plain ESM loader
 * (the `src/worker/vitest.config.ts` "worker" project's `environment: "node"`) cannot resolve at
 * all -- merely importing `webhooksRouter` now fails before a single test can run. This file's
 * actual test logic is otherwise unchanged from Phase 3: every fake (D1, the new
 * `REVIEW_RUN` Durable Object namespace below) is still hand-built, never a real binding: this
 * is `@cloudflare/vitest-pool-workers`'s real `workerd` runtime only so `agents`'s own
 * Cloudflare-only imports resolve, not because this suite drives real D1/Durable Object/Workflow
 * behavior -- that remains Phase 7's job.
 */

/** Find a captured log record by level and exact message -- `CaptureTransport.find()` itself
 * only filters by level, so this narrows further to the specific structured event this test
 * cares about. */
function findLog(
  transport: CaptureTransport,
  level: LogLevel,
  message: string,
) {
  return transport.find(level).find((record) => record.message === message);
}

const GITHUB_SECRET = "github-secret";
const GITLAB_SECRET = "gitlab-secret";

/**
 * A recorded D1 statement, and the minimal fake D1 double this route's two repositories
 * (`../data/reviewRuns.ts`, `../data/webhookDeliveries.ts`) need. `claimResult`/`insertResult`
 * are consumed once per matching statement and then default to "not found"/"conflict" for any
 * further call, letting a single test drive a duplicate-delivery or a run-conflict scenario by
 * queuing more than one value.
 */
function fakeDatabase(options: {
  claimResults?: (Record<string, unknown> | null)[];
  insertResults?: (Record<string, unknown> | null)[];
  selectResult?: Record<string, unknown> | null;
}): Pick<D1Database, "prepare"> {
  const claimResults = [...(options.claimResults ?? [{ id: "claimed" }])];
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
          if (sql.includes("INSERT INTO review_webhook_deliveries")) {
            return (claimResults.shift() ?? null) as T | null;
          }
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
    head_sha: "abc123",
    trigger: "webhook",
    triggered_by_email: null,
    status: "running",
    diff_truncated: 0,
    changed_file_count: 0,
    comment_url: null,
    error_detail: null,
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
  };
}

/** Build a standalone test app mounting only `webhooksRouter`, with a capture-transport logger
 * so log calls can be asserted on directly. */
function buildApp() {
  const transport = createCaptureTransport();
  const app = new Hono<AppBindings>();
  app.use(cloudflareLogger({ transport, level: "trace" }));
  app.route("/api/webhooks", webhooksRouter);
  // Mirrors src/worker/index.ts's real error handler, so a test asserting on a 401 response
  // exercises the same RFC 9457 conversion production traffic gets.
  app.onError(problemDetailsErrorHandler());
  return { app, transport };
}

/**
 * A minimal fake `REVIEW_RUN` Durable Object namespace -- just enough surface for `getAgentByName()`
 * (`agents`, via `partyserver`'s `getServerByName()`) to resolve a stub: `idFromName()` +
 * `.get(id).setName()` (an internal RPC call `getServerByName()` always makes), plus the one
 * real RPC method this route calls, `start()`. Every call's `runId`/payload is recorded on
 * `startedPayloads` so a test can assert `ReviewRunAgent.start()` was (or was not) called, and
 * with what, without a real Durable Object runtime -- that belongs to `tests/integration/`
 * (Phase 7), not this plain-node "worker" Vitest project.
 */
function fakeReviewRunNamespace(startedPayloads: ReviewTrigger[]) {
  return {
    idFromName(name: string) {
      return { toString: () => name };
    },
    get(_id: unknown) {
      return {
        async setName() {
          // getServerByName() always calls this once to name-tag the DO; this route never
          // observes its result.
        },
        async start(payload: ReviewTrigger) {
          startedPayloads.push(payload);
        },
      };
    },
  };
}

function githubEnv(
  database: Pick<D1Database, "prepare">,
  startedPayloads: ReviewTrigger[] = [],
) {
  return {
    DB: database as unknown as D1Database,
    GITHUB_TOKEN: "token",
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    GITLAB_TOKEN: "token",
    GITLAB_WEBHOOK_SECRET: GITLAB_SECRET,
    REVIEW_RUN: fakeReviewRunNamespace(startedPayloads),
  };
}

function pullRequestPayload() {
  return {
    action: "opened",
    pull_request: {
      number: 42,
      html_url: "https://github.com/octo-org/octo-repo/pull/42",
      title: "Add a feature",
      user: { login: "octocat" },
      head: { sha: "abc123" },
    },
    repository: { full_name: "octo-org/octo-repo" },
  };
}

function mergeRequestPayload() {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { username: "agarcia" },
    project: { path_with_namespace: "flightjs/flight-management" },
    object_attributes: {
      id: 93,
      iid: 16,
      action: "open",
      title: "Add validation",
      url: "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
      updated_at: "2026-01-16 05:56:25 UTC",
      last_commit: { id: "e59094b8de0f2f91abbe4760a52d9137260252d8" },
    },
  };
}

describe("POST /api/webhooks/github", () => {
  it("accepts a validly signed delivery, starts ReviewRunAgent, and responds 202 with the new run", async () => {
    const database = fakeDatabase({ insertResults: [defaultRunRow()] });
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    const payload = pullRequestPayload();
    const body = JSON.stringify(payload);
    const signature = `sha256=${await hmacSha256Hex(GITHUB_SECRET, body)}`;

    const response = await app.request(
      "/api/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-1",
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json).toEqual({ runId: "generated-run-id", status: "running" });

    expect(findLog(transport, "info", "webhook_received")).not.toBeUndefined();
    expect(findLog(transport, "info", "review_started")).not.toBeUndefined();
    // Only a genuinely new run starts the pipeline (item 10's "created is true" guard).
    expect(startedPayloads).toEqual([
      {
        runId: "generated-run-id",
        ref: expect.objectContaining({
          provider: "github",
          repoFullName: "octo-org/octo-repo",
          prNumber: 42,
        }),
      },
    ]);
    // Never log the raw body, the signature, or the webhook secret.
    for (const record of transport.records) {
      expect(JSON.stringify(record)).not.toContain(GITHUB_SECRET);
      expect(JSON.stringify(record)).not.toContain(payload.pull_request.title);
    }
  });

  it("rejects a request with an invalid signature with 401 and logs webhook_rejected", async () => {
    const database = fakeDatabase({});
    const { app, transport } = buildApp();
    const body = JSON.stringify(pullRequestPayload());

    const response = await app.request(
      "/api/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-hub-signature-256":
            "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          "x-github-delivery": "delivery-1",
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database),
    );

    expect(response.status).toBe(401);
    expect(findLog(transport, "warn", "webhook_rejected")).not.toBeUndefined();
    expect(findLog(transport, "info", "webhook_received")).toBeUndefined();
  });

  it("responds 202 with a duplicate status for an already-claimed delivery, without creating a run or starting the agent", async () => {
    const database = fakeDatabase({ claimResults: [null] });
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    const body = JSON.stringify(pullRequestPayload());
    const signature = `sha256=${await hmacSha256Hex(GITHUB_SECRET, body)}`;

    const response = await app.request(
      "/api/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-1",
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "duplicate" });
    expect(
      findLog(transport, "info", "webhook_duplicate_delivery"),
    ).not.toBeUndefined();
    expect(findLog(transport, "info", "review_started")).toBeUndefined();
    expect(startedPayloads).toEqual([]);
  });

  it("does not log review_started or start the agent when the run already existed (a race with a manual trigger)", async () => {
    // A newly claimed delivery, but createOrGetReviewRun() reports the run already existed --
    // simulating a manual trigger and this webhook racing for the same (provider, repo,
    // prNumber, headSha) tuple.
    const database = fakeDatabase({
      insertResults: [null],
      selectResult: defaultRunRow(),
    });
    const startedPayloads: ReviewTrigger[] = [];
    const { app, transport } = buildApp();
    const body = JSON.stringify(pullRequestPayload());
    const signature = `sha256=${await hmacSha256Hex(GITHUB_SECRET, body)}`;

    const response = await app.request(
      "/api/webhooks/github",
      {
        method: "POST",
        headers: {
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-1",
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database, startedPayloads),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "generated-run-id",
      status: "running",
    });
    expect(findLog(transport, "info", "review_started")).toBeUndefined();
    expect(startedPayloads).toEqual([]);
  });
});

describe("POST /api/webhooks/gitlab", () => {
  it("accepts a validly tokened delivery and responds 202 with the new run", async () => {
    const database = fakeDatabase({
      insertResults: [{ ...defaultRunRow(), provider: "gitlab" }],
    });
    const { app, transport } = buildApp();
    const body = JSON.stringify(mergeRequestPayload());

    const response = await app.request(
      "/api/webhooks/gitlab",
      {
        method: "POST",
        headers: {
          "x-gitlab-token": GITLAB_SECRET,
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database),
    );

    expect(response.status).toBe(202);
    expect(findLog(transport, "info", "review_started")).not.toBeUndefined();
  });

  it("rejects a request with a mismatched token with 401", async () => {
    const database = fakeDatabase({});
    const { app, transport } = buildApp();
    const body = JSON.stringify(mergeRequestPayload());

    const response = await app.request(
      "/api/webhooks/gitlab",
      {
        method: "POST",
        headers: {
          "x-gitlab-token": "wrong-token",
          "content-type": "application/json",
        },
        body,
      },
      githubEnv(database),
    );

    expect(response.status).toBe(401);
    expect(findLog(transport, "warn", "webhook_rejected")).not.toBeUndefined();
  });
});
