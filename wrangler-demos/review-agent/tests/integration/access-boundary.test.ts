import { afterEach, describe, expect, it, vi } from "vitest";
import {
  driveRequest,
  githubPullRequestPayload,
  signedGithubWebhookRequest,
} from "./support/fixtures";

/**
 * Proves the inverted Access model from docs/07-PR-REVIEW-AGENT.md's "Access Model" end to end,
 * through the real Worker (`exports.default.fetch()`, via `driveRequest()`) rather than
 * `src/worker/access-policies.ts`'s own unit test (`src/worker/middleware/access.test.ts`),
 * which only asserts the policy *array*'s shape, never that `cloudflareAccess()` actually
 * enforces it. Implementation Plan Phase 7, item 29's scenario 1.
 */
describe("Access boundary: the hostname-wide allow application vs. the webhook bypass application", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("blocks an unauthenticated POST /api/reviews with 401, while an unauthenticated but validly signed POST /api/webhooks/github is allowed through", async () => {
    const unauthenticated = await driveRequest(
      "/api/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/octo-org/octo-repo/pull/1",
        }),
      },
      null,
    );
    expect(unauthenticated.status).toBe(401);

    const fetchMock = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const webhookRequest = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4001 }),
    );
    // driveRequest() is not used here -- a webhook delivery carries no Access identity at all
    // (the whole point of this test), so this goes straight through `exports.default.fetch()`.
    const { exports } = await import("cloudflare:workers");
    const webhookResponse = await exports.default.fetch(webhookRequest);

    // Accepted (202) even though the changed-files fetch inside the pipeline it starts will
    // itself fail later -- this test only asserts the Access boundary, not pipeline success.
    expect(webhookResponse.status).toBe(202);
  });

  it("rejects a GitHub webhook with an invalid signature with 401, before any Access identity is ever considered", async () => {
    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload(),
      {
        secret: "wrong-secret",
      },
    );
    const response = await driveRequest(
      "/api/webhooks/github",
      {
        method: request.method,
        headers: request.headers,
        body: await request.clone().text(),
      },
      null,
    );
    expect(response.status).toBe(401);
  });

  it("rejects a GitLab webhook with a mismatched X-Gitlab-Token with 401", async () => {
    const response = await driveRequest(
      "/api/webhooks/gitlab",
      {
        method: "POST",
        headers: {
          "x-gitlab-token": "wrong-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_kind: "merge_request",
          object_attributes: { action: "open" },
        }),
      },
      null,
    );
    expect(response.status).toBe(401);
  });

  it("still requires a verified Access identity for GET /api/reviews (the paginated history list)", async () => {
    const response = await driveRequest("/api/reviews", {}, null);
    expect(response.status).toBe(401);
  });

  it("still requires a verified Access identity for the /agents/review-run/:id WebSocket route", async () => {
    const response = await driveRequest(
      "/agents/review-run/some-run-id",
      { headers: { upgrade: "websocket" } },
      null,
    );
    expect(response.status).toBe(401);
  });

  it("routes an authenticated /agents/review-run/:id request past Access to the Agents SDK's own routing (src/worker/index.ts's app.all(\"/agents/*\", ...) handler)", async () => {
    // No `upgrade: websocket` header here -- this deliberately is not a real WebSocket
    // handshake, only confirms the request reaches `routeAgentRequest()` at all once an Access
    // identity is present. `ReviewRunAgent` overrides no `onRequest()` of its own, so
    // `agents`'s own base class responds with its own diagnostic 404 -- still a defined
    // `Response`, not `undefined`, so `app.all("/agents/*", ...)`'s own `response ?? notFound()`
    // fallback is exercised on its non-null branch.
    const response = await driveRequest("/agents/review-run/some-run-id");
    expect(response.status).toBe(404);
  });
});
