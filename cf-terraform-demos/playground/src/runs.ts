/**
 * @file Run and cost contracts, shared by the Worker tiers and the browser. A **run** is one thing
 *   a person asked for. It is not the same as one model call: Semantic Search embeds a query plus
 *   every uncached passage and is still a single run from the user's point of view. Modelling the
 *   user's action rather than the HTTP call is what lets the session meter add up honestly when one
 *   click costs several inference requests. These are wire contracts: the Worker produces them and
 *   the browser's cost meter consumes them. They live beside `tasks.ts` at `src/` for the same
 *   reason — one definition means the ledger cannot drift from the receipts it adds up. They
 *   contain types only, no bindings and no behaviour beyond an empty-ledger factory, so sharing
 *   them with browser code leaks nothing.
 */

import type { TaskId } from './tasks';

/**
 * Whether the cost of a run is known yet, and if not, why not.
 *
 * AI Gateway log records are written asynchronously, so cost is frequently unknown at the instant
 * the model answers. The product's rule is that a missing cost stays visibly missing: there is no
 * `0` state, because a free-looking run and an unmeasured run are completely different claims and
 * conflating them would make the whole cost meter untrustworthy.
 */
export type CostStatus =
  /**
   * The gateway log has not been read back yet; the UI should poll.
   */
  | 'pending'
  /**
   * A cost figure was reported by the gateway and is shown.
   */
  | 'available'
  /**
   * The log did not arrive within the bounded retry budget, or carried no cost.
   */
  | 'unavailable'
  /**
   * No inference happened, so there is nothing to cost.
   */
  | 'not-applicable';

/**
 * Lifecycle state of a run.
 */
export type RunStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Normalised view of one AI Gateway log record.
 *
 * Fields are optional because the gateway reports what the provider gave it: a per-track music
 * model has no token counts, and a model billed per second of audio has no useful `tokensIn`.
 * Representing that as absence rather than zero keeps the UI honest.
 */
export interface GatewayRequestMetric {
  /**
   * AI Gateway log identifier, safe to display. It identifies a log record, not its contents, and
   * this demo stores no payloads in those records.
   */
  logId: string;
  /**
   * Model the gateway reported for this request.
   */
  model: string;
  /**
   * Provider the gateway reported.
   */
  provider: string;
  /**
   * Whether the gateway served this request from its cache. A cache hit is the one case where a
   * real answer legitimately costs nothing new, and the UI labels it as such rather than as an
   * unmeasured cost.
   */
  cached: boolean;
  /**
   * Whether the upstream request succeeded.
   */
  success: boolean;
  /**
   * End-to-end duration in milliseconds as measured by the gateway.
   */
  durationMs: number;
  /**
   * Cost in US dollars exactly as reported by the gateway, when it reported one. Never computed
   * locally from token counts.
   */
  costUsd?: number;
  /**
   * Input tokens, when the provider reports them.
   */
  tokensIn?: number;
  /**
   * Output tokens, when the provider reports them.
   */
  tokensOut?: number;
}

/**
 * What the API returns for an inference request.
 *
 * The receipt is returned as soon as the model answers and deliberately does not wait for cost.
 * Blocking an answer for a few hundred milliseconds of log propagation would make every panel feel
 * slower in order to display a number nobody is waiting for.
 */
export interface RunReceipt {
  /**
   * Opaque run identifier.
   */
  runId: string;
  /**
   * Panel that produced the run.
   */
  task: TaskId;
  /**
   * Model used, or the first model when a run made several calls.
   */
  model: string;
  /**
   * `true` for gateway-routed inference. A documented exception is the only way this can be
   * `false`, and the UI renders that case differently rather than hiding it.
   */
  gatewayRouted: boolean;
  /**
   * Gateway log identifiers captured for this run, in call order. A multi-call run such as Semantic
   * Search contributes several.
   */
  logIds: string[];
  /**
   * Lifecycle state at the moment the receipt was produced.
   */
  status: RunStatus;
  /**
   * Cost resolution state; see {@link CostStatus}.
   */
  costStatus: CostStatus;
  /**
   * Wall-clock duration the Worker measured, in milliseconds. Independent of the gateway's own
   * figure, and available immediately.
   */
  elapsedMs: number;
  /**
   * ISO 8601 timestamp of when the run started.
   */
  startedAt: string;
}

/**
 * Resolved metrics for one run, returned by `GET /api/runs/:runId/metrics`.
 */
export interface RunMetrics {
  /**
   * Run the metrics belong to.
   */
  runId: string;
  /**
   * Cost resolution state for the run as a whole. A run is only `available` when every one of its
   * gateway calls reported a cost; a partially resolved run stays `pending` rather than showing a
   * total that silently omits a request.
   */
  costStatus: CostStatus;
  /**
   * Sum of the reported costs, present only when `costStatus` is `available`.
   */
  totalCostUsd?: number;
  /**
   * One entry per gateway request the run made.
   */
  requests: GatewayRequestMetric[];
  /**
   * Suggested milliseconds to wait before polling again, when `costStatus` is `pending`.
   */
  retryAfterMs?: number;
}

/**
 * Running totals for the current browser session, shown in the shell's cost meter.
 *
 * `pendingRuns` and `unavailableRuns` are counted separately from the total rather than folded into
 * it. A meter reading "$0.0021 (2 pending)" is truthful; one reading "$0.0021" while two runs are
 * unaccounted for is not.
 */
export interface SessionCostLedger {
  /**
   * Number of runs started in this browser session.
   */
  runCount: number;
  /**
   * Sum of every known cost, in US dollars.
   */
  knownCostUsd: number;
  /**
   * Runs whose cost has not resolved yet.
   */
  pendingRuns: number;
  /**
   * Runs whose cost will never resolve.
   */
  unavailableRuns: number;
  /**
   * Gateway requests served from cache, which incurred no new provider charge.
   */
  cachedRequests: number;
  /**
   * Gateway requests that reached a provider.
   */
  billedRequests: number;
}

/**
 * An empty session ledger, used as the shell's initial state.
 *
 * @returns A ledger with every counter at zero.
 */
export function emptySessionCostLedger(): SessionCostLedger {
  return {
    runCount: 0,
    knownCostUsd: 0,
    pendingRuns: 0,
    unavailableRuns: 0,
    cachedRequests: 0,
    billedRequests: 0
  };
}
