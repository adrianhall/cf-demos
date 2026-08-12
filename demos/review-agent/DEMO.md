# PR Review Agent Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/review-agent`.
2. Set the one-time Wrangler secrets (`README.md`'s "One-Time Secrets") for at least GitHub.
3. Configure a webhook on a real GitHub repository you control, pointing at `https://<DEMO_NAME>.<DEMO_DOMAIN>/api/webhooks/github`, content type `application/json`, the configured shared secret, and the **Pull requests** event only.
4. Confirm you can sign in to `https://<DEMO_NAME>.<DEMO_DOMAIN>/` through your identity provider.
5. Prepare a small, harmless pull request in that repository (a few changed files, including at least one non-`.vue`/`.tsx`/`.css` file so you can show accessibility being skipped) that you can open live, or that is already open and ready to update with a new commit.
6. Open a second browser tab to the Cloudflare dashboard, signed in to the target account.
7. **Optional rehearsal step** (do this only once, well before presenting, and revert it before the real run): `src/worker/workflows/ReviewPipelineWorkflow.ts`'s `fetch-diff` step has no built-in feature flag or environment variable to force a rehearsal failure — the honest rehearsal trick available today is to temporarily edit that step's callback to `throw new Error("rehearsal")` on, say, every third call (or simply on the very next call), deploy that change, trigger one throwaway run to capture the retry in the Workflow's own step timeline (see step 4 below), then revert the edit and redeploy before the real demo. Do this well ahead of time — never mid-presentation — and confirm the revert deployed successfully before presenting.

## Presentation Flow

1. Open the prepared pull request (or push a new commit to it) on GitHub. Do not touch this demo's UI yet.
2. Within moments, switch to `https://<DEMO_NAME>.<DEMO_DOMAIN>/`, sign in, and point out the new run at the top of **Review History** with status "Running" — no manual step started it.
3. Open that run's detail page (click through from the history list). Watch each reviewer's badge move from "Queued" to "Running" to "Done" one at a time — code quality first, then accessibility (show its badge reads "Skipped" with the reason, since this PR touched no UI-relevant file), then architecture, then security. Point out each badge's cost moving from "Pending" to a real dollar figure as AI Gateway confirms it.
4. Switch to the Cloudflare dashboard tab. Open **Workers & Pages** > `<DEMO_NAME>` > **Workflows** > **review-pipeline-workflow**, find this run's instance (newest first), and open its step timeline: one `review:<role>` step per active reviewer, one `reconcile-cost:<role>` step per reviewer that ran, and `merge-and-post-comment`, each with its own status and retry count. If you captured a rehearsal retry (Demonstration Prerequisites, step 7), open that earlier instance instead and point out that only the one step that failed shows more than one attempt — every other reviewer's own step still shows exactly one attempt, and its already-recorded finding and cost were never touched by the retry.
5. Back on GitHub, refresh the pull request and show the posted review comment: an executive summary, a P0–P3 severity table, and the top-priority findings, with a link back to the full report.
6. Click that link (or navigate back to the run's detail page in the demo UI) and scroll to the full report: every finding including the lower-priority ones the comment omitted, and each reviewer's raw output under its own collapsible section.
7. Back on the demo's home page, paste a GitLab merge request URL into the **Pull request or merge request URL** field and select **Review this PR/MR** — no webhook configuration was needed for this path at all. You are navigated straight to the new run's detail page.
8. Switch to the Cloudflare dashboard and open **Workers & Pages** > `<DEMO_NAME>` > **Logs**. Filter for `review_started`, `reviewer_completed`, `reviewer_skipped`, or `review_posted`, and open one `reviewer_completed` event for the run from step 2 — point out its `runId`, `role`, `model`, and `findingCount` fields, and that no diff text or finding text appears anywhere in it.
9. Open **AI Gateway** > `<DEMO_NAME>-gateway` in the dashboard and show the individual model calls for that same run's reviewers — their real, confirmed cost — and point out it matches the dollar figure the UI showed as "confirmed" in step 3.

## Expected Results

- A webhook delivery starts a run with no manual step; the UI reflects live progress within seconds of each reviewer's own step completing.
- Accessibility is skipped (not run, not billed) whenever the diff touches no UI-relevant file.
- The posted comment always links back to a full report containing every finding, never only the ones the comment itself included.
- A transient step failure retries only that one step — every other reviewer's finding/cost is untouched.
- No Workers Logs event for this demo ever contains diff text, finding text, or a provider token.
- The UI's "confirmed" cost figure always matches AI Gateway's own dashboard figure for the same call.

## Where To Observe State

- **Live run progress:** the run's own detail page (reviewer badges, cost, live-region announcements).
- **Workflow step timeline:** Workers & Pages > `<DEMO_NAME>` > Workflows > `review-pipeline-workflow` > the run's instance.
- **Worker logs:** Workers & Pages > `<DEMO_NAME>` > Logs; filter `message` for `review_started`/`reviewer_completed`/`reviewer_skipped`/`review_posted`.
- **AI Gateway calls and cost:** AI Gateway > `<DEMO_NAME>-gateway`.
- **D1 data:** D1 > `<DEMO_NAME>-db`; `review_runs`/`review_reviewers`/`review_findings` tables.
- **Access applications:** Zero Trust > Access controls > Applications; inspect the hostname-wide application and the two-webhook-path bypass application.

Run `npm run teardown` after the presentation; see `README.md` for details.
