/**
 * @file Mapping from a Workflow instance's status onto this demo's task-neutral media-job state.
 *   The translation exists so no provider or platform vocabulary reaches a route or the browser. It
 *   is also the one place where a future platform change can break this panel quietly, so it is
 *   written to fail loudly instead: the mapping is exhaustive over the documented status list and
 *   an unrecognised status is treated as a failure rather than defaulted to `running`. Defaulting
 *   to `running` would be the comfortable choice and the wrong one — a job stuck in a state we do
 *   not understand would poll forever, which is precisely the frozen-request behaviour this panel
 *   exists to avoid.
 */

import type { MediaJobState } from '../../shared/create-video';

/**
 * Step policy for the inference call that generates a video.
 *
 * **Retries are disabled, and that is the point of this constant existing.** Workflow steps retry
 * by default, which is normally their whole value. Here the step bills per second of generated
 * video and can cost several dollars, so an inherited default would turn one transient provider
 * fault into several charges — and nothing about the panel's behaviour would look wrong while it
 * happened.
 *
 * It lives in the domain rather than inline in the Workflow for two reasons: the policy is a
 * reviewed cost decision rather than an implementation detail, and a constant can be asserted by a
 * test that does not need the Workers runtime to load.
 *
 * A failure here is reported to the visitor, who can decide whether to spend the money again. That
 * decision is theirs, not a retry policy's.
 */
export const VIDEO_INFERENCE_STEP_POLICY = {
  retries: { limit: 0, delay: 0 },
  // Generous but finite. The reviewed models take minutes rather than seconds, and a step with no
  // timeout could occupy an instance indefinitely if a provider never answered.
  timeout: '15 minutes'
} as const;

/**
 * Step policy for fetching the provider's video and writing it to storage.
 *
 * Retries are wanted here, unlike the step above, and the contrast is deliberate: fetching a URL
 * and writing it to a fixed key is idempotent — a repeat overwrites the same object rather than
 * spending anything — and this is the step most exposed to a transient network fault.
 */
export const VIDEO_STORAGE_STEP_POLICY = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes'
} as const;

/**
 * The Workflow instance statuses this demo knows how to interpret.
 *
 * Declared locally rather than imported from the runtime types so the mapping below can be driven
 * from a list in a test. The names mirror `InstanceStatus['status']` exactly.
 */
export const WORKFLOW_STATUSES = [
  'queued',
  'running',
  'paused',
  'errored',
  'terminated',
  'complete',
  'waiting',
  'waitingForPause',
  'unknown'
] as const;

/**
 * One Workflow instance status; see {@link WORKFLOW_STATUSES}.
 */
export type WorkflowStatusName = (typeof WORKFLOW_STATUSES)[number];

/**
 * Reports whether a value is a Workflow status this demo recognises.
 *
 * @param value Candidate status, from the Workflow binding.
 * @returns `true` when the status is one of {@link WORKFLOW_STATUSES}.
 */
export function isKnownWorkflowStatus(value: string): value is WorkflowStatusName {
  return (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

/**
 * Translates a Workflow instance status into a media-job state.
 *
 * The groupings are deliberate rather than mechanical:
 *
 * - `queued` maps to `accepted`, because from a visitor's perspective "waiting for capacity" and
 *   "accepted but not started" are the same thing and neither has begun spending money.
 * - `waiting` and `waitingForPause` map to `running`. The instance is hibernating or finishing its
 *   current work, but the job is in flight and the honest thing to show is progress.
 * - `paused` also maps to `running`. Nothing in this panel pauses a job, so a paused instance means
 *   someone intervened out of band; reporting it as a failure would be wrong, since the work is
 *   still there to resume.
 * - `terminated` maps to `cancelled`, because this demo terminates an instance only when a visitor
 *   cancels it. If a job were ever terminated by some other means, `cancelled` is still the more
 *   accurate of the available answers: the work stopped deliberately rather than broke.
 * - `unknown` maps to `failed`, as does anything unrecognised. A job whose state cannot be determined
 *   is not a job that should be polled indefinitely.
 *
 * @param status The status reported by the Workflow binding.
 * @returns The corresponding media-job state.
 */
export function mediaJobStateFromWorkflow(status: string): MediaJobState {
  switch (status) {
    case 'queued':
      return 'accepted';
    case 'running':
    case 'waiting':
    case 'waitingForPause':
    case 'paused':
      return 'running';
    case 'complete':
      return 'completed';
    case 'terminated':
      return 'cancelled';
    case 'errored':
    case 'unknown':
      return 'failed';
    default:
      // An undocumented status, which means the platform has grown a state this demo has not been
      // taught. Failing is the safe direction: it ends the poll and surfaces the job honestly as
      // broken, rather than leaving a visitor watching a spinner for a state nobody understands.
      return 'failed';
  }
}
