/** HTTP status codes {@link isPermanentFetchDiffError} treats as a permanent condition --
 * retrying `GitProviderClient.fetchDiff()` cannot help either one (docs/07-PR-REVIEW-AGENT.md,
 * "Review Orchestration": "A permanent provider response (`404`, `403` -- the PR/MR genuinely
 * does not exist or is not reachable with this token)"). */
const PERMANENT_STATUS_CODES = [403, 404];

/**
 * Whether a `GitProviderClient.fetchDiff()` rejection represents a permanent condition
 * `ReviewPipelineWorkflow`'s `fetch-diff` step should convert into a `NonRetryableError`, rather
 * than a transient one (a `5xx`, a timeout) that step's own retry configuration should handle.
 *
 * Every provider client (`../providers/github.ts`, `../providers/gitlab.ts`) throws a plain
 * `Error` whose message embeds the literal string `"status <code>"` -- there is no structured
 * status field on the thrown error today, so this function matches that text rather than a
 * typed property. Factored into its own pure function (Implementation Plan Phase 4, item 19's
 * own encouragement) since a Workflow step's control flow itself cannot be driven from a plain
 * Vitest unit test.
 *
 * @param error Whatever `fetchDiff()` rejected with.
 * @returns `true` when the error's message indicates a `403`/`404` response.
 */
export function isPermanentFetchDiffError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return PERMANENT_STATUS_CODES.some((code) =>
    error.message.includes(`status ${code}`),
  );
}
