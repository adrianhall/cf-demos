/**
 * @file Application port for durable media jobs. Named for the capability rather than the product,
 *   so the application tier never learns that Workflows is what provides it. That matters more than
 *   the usual reason: the status vocabulary a Workflow reports is a platform detail with nine
 *   values, and letting it leak would make every consumer — including the browser — depend on it.
 *   The translation happens in `domain/media-job.ts` and the application tier only ever sees this
 *   demo's five states.
 */

import type { MediaJobState } from '../../../shared/create-video';

/**
 * What a job reports about itself.
 */
export interface MediaJobStatus {
  /**
   * Current state in this demo's vocabulary.
   */
  state: MediaJobState;
  /**
   * The finished instance's output, when it completed. Shape is the Workflow's output type; the
   * caller narrows it.
   */
  output?: unknown;
  /**
   * Why the job failed, from the instance's recorded error. Sanitised by the caller before it
   * reaches a browser — a provider's own text may name internal hosts or request identifiers.
   */
  error?: string;
}

/**
 * Durable execution of long-running media generation.
 */
export interface MediaJobPort {
  /**
   * Starts a job under a caller-chosen identifier.
   *
   * The identifier is supplied rather than generated, because it is derived from the verified
   * identity and the run identifier — that derivation is what makes a job readable by its creator
   * and nobody else, so the port must not invent its own.
   *
   * @param jobId Derived job identifier.
   * @param params Parameters the job needs, serialised into instance state.
   * @returns A promise fulfilled once the job exists.
   * @throws {Error} When a job already exists under the identifier, which means the same identity
   *   reused a run identifier rather than that two visitors collided.
   */
  start(jobId: string, params: unknown): Promise<void>;

  /**
   * Reads a job's current status.
   *
   * @param jobId Derived job identifier.
   * @returns The status, or `undefined` when no such job exists. Absence is how the ownership check
   *   expresses itself: an identifier derived from a different identity simply does not exist.
   */
  status(jobId: string): Promise<MediaJobStatus | undefined>;

  /**
   * Stops a running job.
   *
   * @param jobId Derived job identifier.
   * @returns `true` when a job was found and terminated, `false` when none existed.
   */
  cancel(jobId: string): Promise<boolean>;
}
