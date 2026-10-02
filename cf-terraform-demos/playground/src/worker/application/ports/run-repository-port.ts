/**
 * @file Storage contract for in-flight runs.
 */

import type { RunStatus } from '../../../shared/runs';
import type { TaskId } from '../../../shared/tasks';

/**
 * A run as the server remembers it between the inference response and the later metrics request.
 *
 * The server keeps the minimum needed to authorise and resolve a follow-up metrics call: who owns
 * it, which panel it came from, and which gateway logs to read. It deliberately does not keep the
 * prompt, the model output, or any media — a metrics lookup does not need them, and storing them
 * would create a retention question the demo has no reason to answer.
 */
export interface RunRecord {
  /**
   * Opaque run identifier.
   */
  runId: string;
  /**
   * Panel that produced the run.
   */
  task: TaskId;
  /**
   * Model used for the run's first call.
   */
  model: string;
  /**
   * Verified email of the identity that created the run. A metrics request from any other identity
   * is refused, so one user cannot read another's cost history by guessing a run identifier.
   */
  ownerEmail: string;
  /**
   * Gateway log identifiers captured for the run, in call order.
   */
  logIds: string[];
  /**
   * Lifecycle state.
   */
  status: RunStatus;
  /**
   * Epoch milliseconds when the run started, used to expire old records.
   */
  startedAtMs: number;
}

/**
 * Where run records live.
 *
 * Phase 1 ships no implementation and Phase 3 introduces an in-memory one. In-memory is a real
 * design choice rather than a stopgap: a run record is only useful for the few seconds between an
 * answer and its cost resolving, and a Worker isolate comfortably outlives that. Reaching for KV or
 * D1 here would add a storage product, a teardown step, and a retention policy to hold data that is
 * worthless within a minute. The trade-off — a run whose isolate was recycled answers "unavailable"
 * instead of a cost — is one the UI already handles truthfully.
 */
export interface RunRepositoryPort {
  /**
   * Stores a newly created run.
   *
   * @param record The run to remember; see {@link RunRecord}.
   * @returns A promise fulfilled once the record is retrievable.
   */
  save(record: RunRecord): Promise<void>;

  /**
   * Retrieves a run by identifier, without regard to ownership.
   *
   * The caller is responsible for comparing `ownerEmail` against the verified identity before
   * returning anything derived from the record. Ownership is not applied here because a route that
   * forgot to check would otherwise get a silent empty result that looks like "no such run", hiding
   * the bug.
   *
   * @param runId Run identifier from an untrusted request.
   * @returns The record, or `undefined` when no such run is remembered.
   */
  find(runId: string): Promise<RunRecord | undefined>;
}
