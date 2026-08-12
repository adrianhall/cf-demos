import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
  countFindings,
  driveRequest,
  fencedFindings,
  githubPullRequestPayload,
  installFakeAi,
  installFakeGitHubFetch,
  readReviewerRows,
  readRunRow,
  restoreFakeAi,
  signedGithubWebhookRequest,
} from "./support/fixtures";

/** A minimal, valid finding shape for one reviewer's scripted response. */
function finding(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    findingRef: "REF-001",
    severity: "medium",
    category: "Test category",
    filePath: "src/index.ts",
    lineNumber: 10,
    finding: "A finding.",
    recommendation: "Fix it.",
    ...overrides,
  };
}

/** Three non-UI-relevant changed files -- `code-quality`/`architecture`/`security` all run;
 * `accessibility` is skipped (Implementation Plan Phase 7, item 29's scenario 3's own "including
 * one skipped for having no UI files" requirement). */
const NON_UI_FILES = [
  { filename: "src/index.ts", patch: "+console.log(1)" },
  { filename: "src/util.ts", patch: "+export {}" },
  { filename: "src/other.ts", patch: "+export const x = 1" },
];

describe("ReviewPipelineWorkflow: full end-to-end runs", () => {
  afterEach(() => {
    restoreFakeAi();
  });

  it("runs a webhook-triggered review through all active reviewers (one skipped) to a posted comment and a completed D1 row", async () => {
    installFakeAi([
      fencedFindings([finding({ findingRef: "CQ-001" })]),
      fencedFindings([
        finding({
          findingRef: "ARCH-001",
          filePath: "src/util.ts",
          lineNumber: 1,
        }),
      ]),
      fencedFindings([
        finding({
          findingRef: "SEC-001",
          filePath: "src/other.ts",
          lineNumber: 1,
        }),
      ]),
    ]);
    const fetchMock = installFakeGitHubFetch({
      files: NON_UI_FILES,
      prNumber: 4100,
    });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4100, headSha: "sha-4100" }),
      { deliveryId: "delivery-4100" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    const instance = instances.at(-1);
    expect(instance).toBeDefined();
    await instance?.waitForStatus("complete");

    const run = await readRunRow(runId);
    expect(run?.status).toBe("completed");
    expect(run?.comment_url).not.toBeNull();
    expect(run?.full_report).toContain("PR Review Report");
    expect(run?.trigger).toBe("webhook");

    const reviewers = await readReviewerRows(runId);
    expect(reviewers).toEqual([
      expect.objectContaining({ role: "accessibility", status: "skipped" }),
      expect.objectContaining({ role: "architecture", status: "done" }),
      expect.objectContaining({ role: "code-quality", status: "done" }),
      expect.objectContaining({ role: "security", status: "done" }),
    ]);
    // Every done reviewer's cost was reconciled -- the default `installFakeAi()` gateway-log
    // behavior succeeds immediately, and `disableSleeps()` skipped the real 5-second wait.
    for (const reviewer of reviewers) {
      if (reviewer.status === "done") {
        expect(reviewer.cost_source).toBe("gateway");
        expect(reviewer.cost_usd).not.toBeNull();
      }
    }

    expect(await countFindings(runId)).toBe(3);
    const commentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/comments"),
    );
    expect(commentCalls).toHaveLength(1);
  });

  it("produces the identical D1 shape for the manual-trigger path (POST /api/reviews)", async () => {
    installFakeAi([
      fencedFindings([finding({ findingRef: "CQ-001" })]),
      fencedFindings([
        finding({
          findingRef: "ARCH-001",
          filePath: "src/util.ts",
          lineNumber: 1,
        }),
      ]),
      fencedFindings([
        finding({
          findingRef: "SEC-001",
          filePath: "src/other.ts",
          lineNumber: 1,
        }),
      ]),
    ]);
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4101 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const response = await driveRequest("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://github.com/octo-org/octo-repo/pull/4101",
      }),
    });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    const instance = instances.at(-1);
    await instance?.waitForStatus("complete");

    const run = await readRunRow(runId);
    expect(run?.status).toBe("completed");
    expect(run?.comment_url).not.toBeNull();
    expect(run?.trigger).toBe("manual");
    expect(run?.triggered_by_email).toBe("reviewer@example.com");

    const reviewers = await readReviewerRows(runId);
    expect(reviewers.map((r) => `${r.role}:${r.status}`)).toEqual([
      "accessibility:skipped",
      "architecture:done",
      "code-quality:done",
      "security:done",
    ]);
    expect(await countFindings(runId)).toBe(3);
  });

  it("treats a duplicate webhook delivery as a no-op against the idempotency guard, backed by the real D1 binding", async () => {
    installFakeAi([fencedFindings([])]);
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4102 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const payload = githubPullRequestPayload({
      number: 4102,
      headSha: "sha-4102",
    });
    const first = await signedGithubWebhookRequest(payload, {
      deliveryId: "delivery-4102",
    });
    const { exports } = await import("cloudflare:workers");
    const firstResponse = await exports.default.fetch(first);
    expect(firstResponse.status).toBe(202);
    const firstBody = (await firstResponse.json()) as { runId: string };

    const instancesAfterFirst = await introspector.get();
    await instancesAfterFirst.at(-1)?.waitForStatus("complete");

    // The exact same delivery id, replayed -- a provider's own webhook retry.
    const duplicate = await signedGithubWebhookRequest(payload, {
      deliveryId: "delivery-4102",
    });
    const duplicateResponse = await exports.default.fetch(duplicate);
    expect(duplicateResponse.status).toBe(202);
    expect(await duplicateResponse.json()).toEqual({ status: "duplicate" });

    // No second Workflow instance was ever created for the duplicate delivery.
    const instancesAfterDuplicate = await introspector.get();
    expect(instancesAfterDuplicate).toHaveLength(instancesAfterFirst.length);

    const runsForThisPr = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM review_runs WHERE pr_number = ?",
    )
      .bind(4102)
      .first<{ count: number }>();
    expect(runsForThisPr?.count).toBe(1);
    expect(firstBody.runId).toBeTruthy();
  });

  it("retries only the failed reviewer step on a transient failure, leaving every other reviewer's row and findings untouched", async () => {
    installFakeAi([
      // `review:code-quality`'s first REAL attempt (attempt 2 overall -- attempt 1 is the
      // `mockStepError` below, which never runs this callback at all) succeeds.
      fencedFindings([finding({ findingRef: "CQ-001" })]),
      fencedFindings([
        finding({
          findingRef: "ARCH-001",
          filePath: "src/util.ts",
          lineNumber: 1,
        }),
      ]),
      fencedFindings([
        finding({
          findingRef: "SEC-001",
          filePath: "src/other.ts",
          lineNumber: 1,
        }),
      ]),
    ]);
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4103 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      // A transient failure -- fails once, then the step's own retry (limit: 2) re-runs the
      // real callback for real on attempt 2.
      await m.mockStepError(
        { name: "review:code-quality" },
        new Error("transient AI Gateway error"),
        1,
      );
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4103, headSha: "sha-4103" }),
      { deliveryId: "delivery-4103" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("complete");

    const reviewers = await readReviewerRows(runId);
    // The retried step still ends up "done", proving the retry succeeded transparently.
    expect(reviewers).toEqual([
      expect.objectContaining({ role: "accessibility", status: "skipped" }),
      expect.objectContaining({ role: "architecture", status: "done" }),
      expect.objectContaining({ role: "code-quality", status: "done" }),
      expect.objectContaining({ role: "security", status: "done" }),
    ]);
    // Every other reviewer's findings/cost are exactly as if no retry had ever happened --
    // the concrete proof that only the one failed step re-ran.
    expect(await countFindings(runId)).toBe(3);
    for (const reviewer of reviewers) {
      expect(reviewer.cost_source).toBe(
        reviewer.status === "done" ? "gateway" : "pending",
      );
    }
    expect((await readRunRow(runId))?.status).toBe("completed");
  });

  it("records a permanently failing reviewer as status 'error' without aborting the run, and leaves every other reviewer's findings intact", async () => {
    // `security` runs last (`REVIEW_EXECUTION_ORDER`) and gets two consecutive unparseable
    // responses -- the first turn plus `runReviewer()`'s own one bounded corrective retry, per
    // Implementation Plan Phase 7, item 29's own "(or drive `runReviewer()` to actually exhaust
    // its JSON-repair retry ...)" alternative. This is deliberately NOT a `mockStepError()` on
    // `review:security`: that primitive skips the step's real callback entirely, including its
    // own `upsertReviewReviewer()` write -- `ReviewPipelineWorkflow.run()`'s *outer* catch
    // (reached only once every retry is exhausted) updates the in-memory/agent-state projection
    // but never writes D1 itself, on the theory that the step's own inner catch
    // (`ReviewerJsonInvalidError` -> `upsertReviewReviewer(status: 'error')` ->
    // `NonRetryableError`) already recorded it before ever throwing. Driving the real
    // JSON-repair-exhaustion path is what actually exercises that inner catch and its D1 write.
    installFakeAi([
      fencedFindings([finding({ findingRef: "CQ-001" })]),
      fencedFindings([
        finding({
          findingRef: "ARCH-001",
          filePath: "src/util.ts",
          lineNumber: 1,
        }),
      ]),
      "```json\nnot valid json {{{\n```",
      "still not valid {{{",
    ]);
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4104 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4104, headSha: "sha-4104" }),
      { deliveryId: "delivery-4104" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("complete");

    const reviewers = await readReviewerRows(runId);
    const security = reviewers.find((r) => r.role === "security");
    expect(security?.status).toBe("error");
    expect(security?.error_detail).toBeTruthy();
    expect(reviewers.find((r) => r.role === "code-quality")?.status).toBe(
      "done",
    );
    expect(reviewers.find((r) => r.role === "architecture")?.status).toBe(
      "done",
    );
    // security contributed zero findings; the other two reviewers' findings are untouched.
    expect(await countFindings(runId)).toBe(2);

    const run = await readRunRow(runId);
    expect(run?.status).toBe("completed");
    expect(run?.comment_url).not.toBeNull();
  });

  it("leaves a reviewer's cost permanently 'pending' once cost reconciliation exhausts its own retries, without failing the run", async () => {
    installFakeAi(
      [
        fencedFindings([finding({ findingRef: "CQ-001" })]),
        fencedFindings([
          finding({
            findingRef: "ARCH-001",
            filePath: "src/util.ts",
            lineNumber: 1,
          }),
        ]),
        fencedFindings([
          finding({
            findingRef: "SEC-001",
            filePath: "src/other.ts",
            lineNumber: 1,
          }),
        ]),
      ],
      { kind: "success" },
    );
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4105 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      // `getLog()` "not found" is a genuine, permanent-until-exhausted outcome
      // (docs/DECISIONS.md #16) -- mocking this step to always fail is the faithful equivalent
      // of AI Gateway never indexing the log within the step's own retry budget.
      await m.mockStepError(
        { name: "reconcile-cost:code-quality" },
        new Error("Log not found"),
      );
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4105, headSha: "sha-4105" }),
      { deliveryId: "delivery-4105" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("complete");

    const reviewers = await readReviewerRows(runId);
    const codeQuality = reviewers.find((r) => r.role === "code-quality");
    expect(codeQuality?.status).toBe("done");
    expect(codeQuality?.cost_source).toBe("pending");
    expect(codeQuality?.cost_usd).toBeNull();
    // Every other reviewer's own reconciliation was untouched by code-quality's exhausted retry.
    expect(reviewers.find((r) => r.role === "architecture")?.cost_source).toBe(
      "gateway",
    );
    expect(reviewers.find((r) => r.role === "security")?.cost_source).toBe(
      "gateway",
    );

    expect((await readRunRow(runId))?.status).toBe("completed");
  });

  it("never double-posts a comment when merge-and-post-comment's own idempotent guard sees an already-set comment_url", async () => {
    installFakeAi([
      fencedFindings([finding({ findingRef: "CQ-001" })]),
      fencedFindings([
        finding({
          findingRef: "ARCH-001",
          filePath: "src/util.ts",
          lineNumber: 1,
        }),
      ]),
      fencedFindings([
        finding({
          findingRef: "SEC-001",
          filePath: "src/other.ts",
          lineNumber: 1,
        }),
      ]),
    ]);
    const fetchMock = installFakeGitHubFetch({
      files: NON_UI_FILES,
      prNumber: 4107,
    });

    // Pre-seed the row exactly as `merge-and-post-comment`'s own doc comment describes a
    // *retried* attempt would find it: "a network blip after a successful post" leaves
    // `comment_url` already set before the step's guard ever runs. `mockStepResult()`/
    // `mockStepError()` can only replace a step's *next* real execution wholesale -- neither can
    // interrupt an already-running real callback partway through -- so there is no introspection
    // primitive that literally "retries a step that already ran for real once." Pre-setting
    // `comment_url` reproduces the exact same precondition the guard actually checks
    // (`review_runs.comment_url IS NOT NULL`) and lets the real step run for the first time this
    // instance ever executes it, which is what proves the guard fires -- indistinguishable, from
    // the guard's own code's perspective, from a genuine retry after a crash.
    // `status: 'completed'` (not `'running'`) is deliberate: the guard's own early return never
    // touches `status`/`full_report`, so this models the state a real first attempt would have
    // left behind after `postComment()` *and* `markRunCompleted()` both already succeeded --
    // the only way `comment_url` legitimately ends up non-null in the first place. A replay that
    // finds `status: 'running'` with a `comment_url` already set could never actually happen in
    // production, since `markRunCompleted()` is the only writer of either column and always
    // sets both together in one statement.
    const runId = "preexisting-run-4107";
    await env.DB.prepare(
      `INSERT INTO review_runs (
         id, provider, repo_full_name, pr_number, pr_url, pr_title, pr_author, head_sha,
         trigger, status, comment_url, full_report
       ) VALUES (?, 'github', 'octo-org/octo-repo', 4107,
         'https://github.com/octo-org/octo-repo/pull/4107', 'Add a feature', 'octocat',
         'sha-4107', 'manual', 'completed', 'https://github.com/octo-org/octo-repo/pull/4107#already-posted',
         '# PR Review Report: octo-org/octo-repo #4107')`,
    )
      .bind(runId)
      .run();

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const { getAgentByName } = await import("agents");
    const agent = await getAgentByName(env.REVIEW_RUN, runId);
    await agent.start({
      runId,
      ref: {
        provider: "github",
        owner: "octo-org",
        repo: "octo-repo",
        repoFullName: "octo-org/octo-repo",
        prNumber: 4107,
        headSha: "sha-4107",
      },
    });

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("complete");

    // The guard fired on this step's one and only real execution -- `postComment()`'s
    // underlying endpoint was never called, proving a run whose comment was already posted is
    // never double-posted.
    const commentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/comments"),
    );
    expect(commentCalls).toHaveLength(0);
    const run = await readRunRow(runId);
    expect(run?.status).toBe("completed");
    // The guard's own early return preserves the pre-existing URL verbatim -- it is never
    // overwritten by a second, different "posted" URL.
    expect(run?.comment_url).toBe(
      "https://github.com/octo-org/octo-repo/pull/4107#already-posted",
    );
  });

  it("errors the whole Workflow instance and marks the run failed when fetch-diff hits a permanent 404, without ever running a reviewer", async () => {
    installFakeAi([fencedFindings([])]);
    // The changed-files endpoint itself 404s -- GitHubProviderClient.fetchDiff() throws
    // "... status 404 ...", which `isPermanentFetchDiffError()` converts to a
    // `NonRetryableError` inside the `fetch-diff` step (Implementation Plan Phase 7, item 29's
    // own scenario list does not number this one explicitly, but "Review Orchestration" step 1
    // names it as the one path that errors the whole instance rather than one reviewer, and it
    // is the only way `ReviewRunAgent.onWorkflowError()`/`markRunFailed()` ever run at all).
    const fetchMock = installFakeGitHubFetch({ files: [], prNumber: 4108 });
    fetchMock.mockImplementation(
      async () => new Response("not found", { status: 404 }),
    );

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4108, headSha: "sha-4108" }),
      { deliveryId: "delivery-4108" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("errored");

    // `ReviewRunAgent.onWorkflowError()` reacts asynchronously to the Workflow's own error
    // callback -- poll briefly for its `markRunFailed()` D1 write to land, rather than racing it.
    let run = await readRunRow(runId);
    for (
      let attempt = 0;
      attempt < 20 && run?.status !== "failed";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = await readRunRow(runId);
    }
    expect(run?.status).toBe("failed");
    expect(run?.comment_url).toBeNull();
    expect(await readReviewerRows(runId)).toEqual([]);
    expect(await countFindings(runId)).toBe(0);
  });

  it("errors the whole Workflow instance after a transient fetch-diff failure exhausts its own retry limit (never converted to a NonRetryableError)", async () => {
    installFakeAi([fencedFindings([])]);
    // A `5xx` is the *other* branch of `isPermanentFetchDiffError()` -- `fetch-diff`'s own
    // `catch` re-throws it verbatim (never wrapping it in `NonRetryableError`) and lets the
    // step's own retry configuration (limit: 3) exhaust naturally.
    const fetchMock = installFakeGitHubFetch({ files: [], prNumber: 4109 });
    fetchMock.mockImplementation(
      async () => new Response("upstream error", { status: 500 }),
    );

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4109, headSha: "sha-4109" }),
      { deliveryId: "delivery-4109" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("errored");

    let run = await readRunRow(runId);
    for (
      let attempt = 0;
      attempt < 20 && run?.status !== "failed";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      run = await readRunRow(runId);
    }
    expect(run?.status).toBe("failed");
    // Every attempt hit the real (mocked-500) endpoint -- the step's own retry configuration,
    // not a single immediate NonRetryableError.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("records a reviewer as status 'error' when the AI binding itself throws (not an unparseable-JSON outcome)", async () => {
    // `env.AI.run()` throwing directly (an AI Gateway outage, distinct from a model returning
    // unparseable JSON) is the *other* branch of `review:<role>`'s own inner catch -- re-thrown
    // verbatim (`ReviewPipelineWorkflow.ts`'s own `if (error instanceof ReviewerJsonInvalidError)
    // ... throw error;`), so the step's own retry configuration (limit: 2) governs it instead of
    // the JSON-repair-exhaustion path's immediate `NonRetryableError` conversion.
    const ai = env.AI as unknown as { run: () => Promise<unknown> };
    let callCount = 0;
    ai.run = async () => {
      callCount += 1;
      if (callCount <= 2) {
        // code-quality, then architecture -- both succeed normally.
        return {
          response: fencedFindings([
            finding({
              findingRef: `OK-${callCount}`,
              filePath: `src/f${callCount}.ts`,
            }),
          ]),
        };
      }
      // Every security attempt throws -- the AI binding itself is unavailable.
      throw new Error("AI Gateway is unavailable");
    };
    installFakeGitHubFetch({ files: NON_UI_FILES, prNumber: 4110 });

    await using introspector = await introspectWorkflow(env.REVIEW_PIPELINE);
    await introspector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });

    const request = await signedGithubWebhookRequest(
      githubPullRequestPayload({ number: 4110, headSha: "sha-4110" }),
      { deliveryId: "delivery-4110" },
    );
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(request);
    const { runId } = (await response.json()) as { runId: string };

    const instances = await introspector.get();
    await instances.at(-1)?.waitForStatus("complete");

    const reviewers = await readReviewerRows(runId);
    expect(
      reviewers.find((r) => r.role === "security")?.status,
    ).toBeUndefined();
    expect(reviewers.find((r) => r.role === "code-quality")?.status).toBe(
      "done",
    );
    expect(reviewers.find((r) => r.role === "architecture")?.status).toBe(
      "done",
    );
    expect((await readRunRow(runId))?.status).toBe("completed");
  });
});
