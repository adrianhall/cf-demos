/**
 * @file The run-metrics use case: resolve a run's AI Gateway logs, enforce ownership, and aggregate
 *   the result. The ownership check lives here rather than in the route because it is a rule about
 *   runs, not about HTTP, and a second transport must not be able to reach the data without it.
 */

import { forbidden, notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { GatewayRequestMetric, RunMetrics } from '../../../shared/runs';
import { aggregateRunMetrics } from '../../domain/metrics';
import type { InferencePort, VerifiedActor } from '../ports/inference-port';
import type { RunRepositoryPort } from '../ports/run-repository-port';

/**
 * Dependencies of {@link MetricsService}.
 */
export interface MetricsServiceOptions {
  /**
   * Gateway client used to read logs back.
   */
  inference: InferencePort;
  /**
   * Where run records are stored.
   */
  runs: RunRepositoryPort;
  /**
   * Clock reading epoch milliseconds, injected so the resolution budget can be tested without
   * waiting twenty seconds.
   */
  now?: () => number;
}

/**
 * Resolves the cost of a run from its AI Gateway logs.
 */
export class MetricsService {
  readonly #inference: InferencePort;
  readonly #runs: RunRepositoryPort;
  readonly #now: () => number;

  /**
   * Creates the service.
   *
   * @param options Inference port, run repository, and optional clock; see
   *   {@link MetricsServiceOptions}.
   */
  constructor(options: MetricsServiceOptions) {
    this.#inference = options.inference;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reads the metrics for one run on behalf of a verified caller.
   *
   * Each of the run's log identifiers is resolved independently, and a log that has not propagated
   * is simply absent rather than an error — which is what lets the aggregate answer `pending` and
   * invite another poll instead of failing.
   *
   * @param runId Run identifier from the request path, already shape-checked by the route.
   * @param actor The verified Access identity making the request.
   * @returns The run's aggregated metrics; see {@link RunMetrics}.
   * @throws {ProblemDetailsError} `notFound()` (404) when no such run is remembered, which includes
   *   a run whose isolate was recycled. `forbidden()` (403) when the run belongs to a different
   *   identity.
   */
  async readRunMetrics(runId: string, actor: VerifiedActor): Promise<RunMetrics> {
    const record = await this.#runs.find(runId);
    if (record === undefined) {
      throw notFound({
        detail:
          'That run is not known to this server. Run records are kept only long enough to '
          + 'resolve their cost.'
      });
    }

    // A denial rather than an empty result. An empty metrics document would be indistinguishable
    // from a run with no logs, which would hide the fact that one identity asked for another's
    // data — exactly the event worth being able to see.
    if (record.ownerEmail !== actor.email) {
      throw forbidden({ detail: 'That run belongs to a different user.' });
    }

    const resolved: GatewayRequestMetric[] = [];
    for (const logId of record.logIds) {
      const metric = await this.#inference.readMetric(logId);
      if (metric !== undefined) {
        resolved.push(metric);
      }
    }

    return aggregateRunMetrics(
      runId,
      record.logIds.length,
      resolved,
      this.#now() - record.startedAtMs
    );
  }
}
