import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { vi } from "vitest";
import { hmacSha256Hex } from "../../../src/worker/providers/webhook-crypto";

/**
 * Shared fixtures for Implementation Plan Phase 7's end-to-end integration tests
 * (docs/07-PR-REVIEW-AGENT.md). Every helper here drives the *real* Worker
 * (`exports.default.fetch()`, from `cloudflare:workers` -- confirmed by Cloudflare's own Vitest
 * integration docs to be "exactly the same module instance" `wrangler.jsonc`'s `main` resolves,
 * including every Durable Object/Workflow binding it defines) against a *real* D1 binding and a
 * *real* `ReviewPipelineWorkflow` instance -- never a hand-built fake D1/Durable Object
 * namespace, unlike `webhooks.test.ts`/`reviews.test.ts`'s own router-level tests. The one
 * binding this repository has no way to run locally at all, `AI` (docs/DECISIONS.md #9), is
 * patched directly on the shared `env.AI` object instead (see {@link installFakeAi}) -- this
 * works because a Durable Object/Workflow defined in the same Worker script shares the exact
 * same `env` reference the script's own top-level code does, confirmed live: patching
 * `env.AI.run` from a test file is visible to `ReviewPipelineWorkflow.run()`'s own
 * `this.env.AI.run()` calls, even though the Workflow instance runs inside a Durable Object
 * actor this test file never constructs directly.
 */

/** Matches `../vitest.config.ts`'s own injected `miniflare.bindings.GITHUB_WEBHOOK_SECRET`. */
export const GITHUB_WEBHOOK_SECRET = "test-github-webhook-secret";

/** Matches `../vitest.config.ts`'s own injected `miniflare.bindings.GITLAB_WEBHOOK_SECRET`. */
export const GITLAB_WEBHOOK_SECRET = "test-gitlab-webhook-secret";

/** A verified identity used by every test that does not care which one triggers a run. */
export const REVIEWER_EMAIL = "reviewer@example.com";

/**
 * Send one request through the real Worker (`exports.default.fetch()`), optionally as a
 * verified Cloudflare Access identity.
 *
 * @param path Request path beginning with `/`.
 * @param init Ordinary `fetch` request options.
 * @param email Verified identity to sign a development Access token for, or `null` to send the
 * request with no Access identity at all (for a webhook path, or to prove a management route
 * rejects it).
 * @returns The Worker's real response.
 */
export async function driveRequest(
  path: string,
  init: RequestInit = {},
  email: string | null = REVIEWER_EMAIL,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (email !== null) {
    headers.set(JWT_HEADER, await signDevJwt(email));
  }
  return exports.default.fetch(
    new Request(`https://review-agent.example${path}`, { ...init, headers }),
  );
}

/** A minimal GitHub `pull_request` webhook payload, shaped exactly like
 * `webhooks.test.ts`'s own `pullRequestPayload()` -- kept as a separate copy (rather than an
 * import) since that file's fixture is deliberately scoped to its own fake-D1 router tests, per
 * this project's "one test file's own conventions are not a second file's public API" norm. */
export function githubPullRequestPayload(
  overrides: {
    readonly number?: number;
    readonly headSha?: string;
    readonly action?: string;
    readonly changedFiles?: readonly string[];
  } = {},
): Record<string, unknown> {
  return {
    action: overrides.action ?? "opened",
    pull_request: {
      number: overrides.number ?? 42,
      html_url: `https://github.com/octo-org/octo-repo/pull/${overrides.number ?? 42}`,
      title: "Add a feature",
      user: { login: "octocat" },
      head: { sha: overrides.headSha ?? "abc123" },
    },
    repository: { full_name: "octo-org/octo-repo" },
  };
}

/**
 * Build a real, validly HMAC-signed `POST /api/webhooks/github` request -- the same signing
 * this repository's `hmacSha256Hex()` (`../../../src/worker/providers/webhook-crypto.ts`) itself
 * implements, exercised here from the *caller's* side so a test proves the real route accepts
 * it, not merely that the signing function round-trips with itself.
 *
 * @param payload The webhook body (`githubPullRequestPayload()`).
 * @param options.deliveryId GitHub's own `X-GitHub-Delivery` header value.
 * @param options.secret Override the configured secret, to build a request that must be
 * rejected.
 * @returns A ready-to-send `Request`.
 */
export async function signedGithubWebhookRequest(
  payload: Record<string, unknown>,
  options: { readonly deliveryId?: string; readonly secret?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${await hmacSha256Hex(options.secret ?? GITHUB_WEBHOOK_SECRET, body)}`;
  return new Request("https://review-agent.example/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": signature,
      "x-github-delivery": options.deliveryId ?? crypto.randomUUID(),
      "content-type": "application/json",
    },
    body,
  });
}

/** One changed GitHub file entry, as `GET .../pulls/:number/files` returns it. */
export interface FakeGitHubFile {
  readonly filename: string;
  readonly patch?: string;
}

/**
 * Install a scripted `fetch` mock covering every GitHub REST call
 * `ReviewPipelineWorkflow`/`GitHubProviderClient` makes for one review run: the changed-files
 * page `fetch-diff` reads, the single-PR lookup a manual trigger's `resolvePrMetadata()` reads,
 * and the issue-comment creation `merge-and-post-comment` posts to. Mirrors
 * `reviews.test.ts`/`webhooks.test.ts`'s own `stubFetchOnce()` convention, generalized to cover
 * every endpoint one full pipeline run touches instead of just one call.
 *
 * @param options.files The changed-file list `fetch-diff` should see.
 * @param options.prNumber Which PR number every URL pattern should match -- must agree with the
 * webhook payload/manual-trigger URL under test.
 * @param options.commentUrl The URL the comment-creation endpoint should report back.
 * @returns The underlying `vi.fn()` mock, so a test can assert exactly how many times each
 * endpoint was called (Implementation Plan Phase 7, item 29's scenario 9: proving
 * `postComment()` runs at most once per run).
 */
export function installFakeGitHubFetch(options: {
  readonly files: readonly FakeGitHubFile[];
  readonly prNumber?: number;
  readonly commentUrl?: string;
}): ReturnType<typeof vi.fn> {
  const prNumber = options.prNumber ?? 42;
  const commentUrl =
    options.commentUrl ??
    "https://github.com/octo-org/octo-repo/pull/42#comment";
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes(`/pulls/${prNumber}/files`)) {
        return new Response(JSON.stringify(options.files), { status: 200 });
      }
      if (method === "GET" && url.includes(`/pulls/${prNumber}`)) {
        return new Response(
          JSON.stringify({
            head: { sha: "resolved-head-sha" },
            title: "Add a feature",
            user: { login: "octocat" },
            html_url: `https://github.com/octo-org/octo-repo/pull/${prNumber}`,
          }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.includes(`/issues/${prNumber}/comments`)) {
        return new Response(JSON.stringify({ html_url: commentUrl }), {
          status: 200,
        });
      }
      return new Response(`unexpected fetch: ${method} ${url}`, {
        status: 404,
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** One scripted reviewer completion `env.AI.run()` should return, in `generateText()`'s
 * "native format" (`{ response: string }`, per `workers-ai-provider`'s `processText()`). */
export function fencedFindings(
  findings: readonly Record<string, unknown>[],
): string {
  return `Reviewed the diff.\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\``;
}

/** Behavior {@link installFakeAi} gives `env.AI.gateway(id).getLog()` after installation. */
export type FakeGatewayLogBehavior =
  | { readonly kind: "success"; readonly costUsd?: number }
  | { readonly kind: "not-found" };

/**
 * Patch the shared, real `env.AI` binding's `run()`/`aiGatewayLogId`/`gateway()` surface with a
 * scripted fake -- this repository's only way to drive `ReviewPipelineWorkflow`'s real reviewer
 * steps end to end without live Workers AI/AI Gateway credentials (docs/DECISIONS.md #9: "Workers
 * AI has no local simulator at all", confirmed to also mean Miniflare's own `ai` binding option
 * accepts nothing but a real, credentialed remote-proxy configuration -- there is no equivalent
 * to `kvNamespaces`'s or `serviceBindings`'s own plain-JS-object override for `ai`).
 *
 * Because a Durable Object/Workflow defined in the same Worker script shares the exact same
 * `env` object reference the script's own request handlers do (confirmed live, not merely
 * inferred from documentation), patching `env.AI` here is visible to every one of
 * `ReviewPipelineWorkflow.run()`'s own `this.env.AI` reads for the remainder of the test file --
 * always call {@link restoreFakeAi} in an `afterEach` so one test's script never leaks into the
 * next.
 *
 * @param responses One scripted `generateText()` response per successive call, in order --
 * reused (the last entry repeats) once exhausted, so a short script still covers every reviewer
 * a longer-than-scripted run happens to make.
 * @param gatewayLog How `env.AI.gateway(id).getLog(logId)` should behave for every call this
 * test's Workflow instance(s) make while the patch is installed. Defaults to an immediate
 * success -- see {@link FakeGatewayLogBehavior}.
 * @returns The gateway log ids this fake assigned, one per `run()` call, in call order -- for a
 * test that needs to correlate a specific reviewer's call with its own logged id.
 */
export function installFakeAi(
  responses: readonly string[],
  gatewayLog: FakeGatewayLogBehavior = { kind: "success" },
): { readonly logIds: string[] } {
  const logIds: string[] = [];
  let callCount = 0;
  const ai = env.AI as unknown as {
    run: (...args: unknown[]) => Promise<unknown>;
    aiGatewayLogId: string | null;
    gateway: (id: string) => { getLog: (logId: string) => Promise<unknown> };
  };
  ai.run = async () => {
    const text = responses[callCount] ?? responses.at(-1) ?? "";
    callCount += 1;
    const logId = `fake-log-${callCount}`;
    ai.aiGatewayLogId = logId;
    logIds.push(logId);
    return {
      response: text,
      usage: { completion_tokens: 20, prompt_tokens: 40 },
    };
  };
  ai.gateway = () => ({
    getLog: async () => {
      if (gatewayLog.kind === "not-found") {
        // `AiGatewayLogNotFound` (`worker-configuration.d.ts`) is an ambient TYPE describing the
        // shape of the real binding's own thrown error, never an importable/constructible
        // runtime symbol (confirmed by reading the generated type declaration directly -- see
        // this file's own investigation notes in the Phase 7 completion report). Every catch
        // site this fake needs to fool (`ReviewPipelineWorkflow`'s `reconcile-cost:<role>`
        // step's own bare `catch {}`) discriminates by nothing but "did getLog() throw", so a
        // plain `Error` is a faithful stand-in.
        throw new Error("Log not found");
      }
      return {
        cost: gatewayLog.costUsd ?? 0.0012,
        tokens_in: 120,
        tokens_out: 60,
      };
    },
  });
  return { logIds };
}

/** Restore `env.AI` to a plain non-functional stub after a test that called
 * {@link installFakeAi}, so a later test in the same file never inherits a stale script. */
export function restoreFakeAi(): void {
  const ai = env.AI as unknown as {
    run: (...args: unknown[]) => Promise<unknown>;
    gateway: (id: string) => unknown;
  };
  ai.run = async () => {
    throw new Error(
      "env.AI.run() called with no fake installed -- call installFakeAi() first.",
    );
  };
  ai.gateway = () => {
    throw new Error(
      "env.AI.gateway() called with no fake installed -- call installFakeAi() first.",
    );
  };
}

/** Read back every `review_reviewers` row for a run, ordered by role, for assertions that don't
 * need the full repository-layer camelCase mapping (`../../../src/worker/data/reviewReviewers.ts`
 * intentionally excludes columns like `ai_gateway_log_id` no route ever needs to read back). */
export async function readReviewerRows(runId: string): Promise<
  {
    role: string;
    status: string;
    model: string | null;
    skipped_reason: string | null;
    error_detail: string | null;
    cost_source: string;
    cost_usd: number | null;
  }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT role, status, model, skipped_reason, error_detail, cost_source, cost_usd
     FROM review_reviewers WHERE run_id = ? ORDER BY role`,
  )
    .bind(runId)
    .all<{
      role: string;
      status: string;
      model: string | null;
      skipped_reason: string | null;
      error_detail: string | null;
      cost_source: string;
      cost_usd: number | null;
    }>();
  return results;
}

/** Read back one `review_runs` row's own status/comment/report columns directly, for
 * assertions that need fields `../../../src/worker/data/reviewRuns.ts`'s own readers
 * deliberately omit (`full_report`, see that module's `REVIEW_RUN_COLUMNS` doc comment). */
export async function readRunRow(runId: string): Promise<{
  status: string;
  comment_url: string | null;
  full_report: string | null;
  trigger: string;
  triggered_by_email: string | null;
} | null> {
  return env.DB.prepare(
    `SELECT status, comment_url, full_report, trigger, triggered_by_email
     FROM review_runs WHERE id = ?`,
  )
    .bind(runId)
    .first<{
      status: string;
      comment_url: string | null;
      full_report: string | null;
      trigger: string;
      triggered_by_email: string | null;
    }>();
}

/** Count `review_findings` rows for a run. */
export async function countFindings(runId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM review_findings WHERE run_id = ?",
  )
    .bind(runId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
