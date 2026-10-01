/**
 * @file Turns a set of AI Gateway log records into the cost answer the UI shows. The rules here are
 *   the demo's honesty guarantees expressed as code, which is why they live in the domain tier with
 *   their own tests rather than inline in the metrics route:
 *
 *   - a run whose logs have not all arrived is `pending`, never a partial total;
 *   - a run whose logs will never arrive is `unavailable`, never `$0.00`;
 *   - a total is the sum of what the gateway reported and is never computed from token counts.
 */

import type { CostStatus, GatewayRequestMetric, RunMetrics } from '../../runs';

/**
 * How long to keep polling a run's gateway logs before giving up.
 *
 * Gateway logs are written asynchronously and normally land within a second or two. After this the
 * answer becomes `unavailable`: an honest "we could not measure this" beats a spinner that never
 * resolves, and the run itself succeeded regardless.
 */
export const COST_RESOLUTION_BUDGET_MS = 20_000;

/**
 * Milliseconds the client should wait before polling again.
 *
 * Fixed rather than exponential because the window is short and the expected wait is roughly
 * constant — the log is being written, not queued behind an unknown backlog.
 */
export const COST_RETRY_AFTER_MS = 1_200;

/**
 * Aggregates the resolved logs of one run into its metrics answer.
 *
 * A run is `available` only when every one of its gateway calls reported a cost. Partial resolution
 * stays `pending`, because a total that silently omits one of a run's requests is a wrong number
 * presented as a right one — and Semantic Search in a later phase makes several calls per run, so
 * this is not a hypothetical case.
 *
 * @param runId Run the metrics belong to.
 * @param expectedLogCount How many gateway calls the run made, taken from the stored run record
 *   rather than from the number of logs that happened to resolve.
 * @param resolved The log records that have been read back so far.
 * @param elapsedSinceStartMs How long ago the run started, used to decide whether the budget for
 *   log propagation has run out.
 * @returns The run's metrics, with a `retryAfterMs` hint when the caller should poll again; see
 *   {@link RunMetrics}.
 */
export function aggregateRunMetrics(
  runId: string,
  expectedLogCount: number,
  resolved: GatewayRequestMetric[],
  elapsedSinceStartMs: number
): RunMetrics {
  const budgetExpired = elapsedSinceStartMs >= COST_RESOLUTION_BUDGET_MS;

  // A run that produced no gateway log at all can never resolve, so it does not wait out the
  // budget. That happens when the gateway did not assign an identifier, which is itself worth
  // surfacing rather than presenting as a slow cost.
  if (expectedLogCount === 0) {
    return { runId, costStatus: 'unavailable', requests: resolved };
  }

  const costed = resolved.filter((request) => request.costUsd !== undefined);
  const complete = resolved.length === expectedLogCount && costed.length === expectedLogCount;

  if (complete) {
    return {
      runId,
      costStatus: 'available',
      totalCostUsd: costed.reduce((total, request) => total + (request.costUsd ?? 0), 0),
      requests: resolved
    };
  }

  if (budgetExpired) {
    // The requests that did resolve are still returned: model, cache state, and duration are
    // useful even when the cost never arrived, and discarding them would hide what is known.
    return { runId, costStatus: 'unavailable', requests: resolved };
  }

  return {
    runId,
    costStatus: 'pending',
    requests: resolved,
    retryAfterMs: COST_RETRY_AFTER_MS
  };
}

/**
 * Chooses the cost status to put on a receipt at the moment a run completes.
 *
 * Called while the answer is being returned, long before any log could have propagated, so this
 * never reports `available`. It distinguishes "there is a log to poll for" from "there will never
 * be one", which is what tells the browser whether to start polling at all.
 *
 * @param logIds Gateway log identifiers captured during the run.
 * @returns `pending` when at least one log exists to read back, otherwise `unavailable`.
 */
export function initialCostStatus(logIds: readonly string[]): CostStatus {
  return logIds.length > 0 ? 'pending' : 'unavailable';
}
