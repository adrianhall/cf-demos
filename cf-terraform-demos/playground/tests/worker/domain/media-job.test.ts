/**
 * @file Tests for the Workflow-status translation. The mapping is driven from the full documented
 *   status list rather than from a hand-picked subset, so a platform status this demo has not been
 *   taught fails the suite instead of quietly defaulting. That direction matters: defaulting an
 *   unknown status to `running` would be the comfortable choice and would leave a visitor watching
 *   a spinner for a job nobody can account for.
 */

import { describe, expect, it } from 'vitest';
import { isTerminalMediaJobState, type MediaJobState } from '../../../src/shared/create-video';
import {
  isKnownWorkflowStatus,
  mediaJobStateFromWorkflow,
  VIDEO_INFERENCE_STEP_POLICY,
  VIDEO_STORAGE_STEP_POLICY,
  WORKFLOW_STATUSES
} from '../../../src/worker/domain/media-job';

describe('mediaJobStateFromWorkflow', () => {
  it.each([
    ['queued', 'accepted'],
    ['running', 'running'],
    ['waiting', 'running'],
    ['waitingForPause', 'running'],
    ['paused', 'running'],
    ['complete', 'completed'],
    ['terminated', 'cancelled'],
    ['errored', 'failed'],
    ['unknown', 'failed']
  ] satisfies [string, MediaJobState][])('maps %s to %s', (status, expected) => {
    expect(mediaJobStateFromWorkflow(status)).toBe(expected);
  });

  it('maps every documented status to a state', () => {
    // Driven from the list itself, so adding a status to `WORKFLOW_STATUSES` without teaching the
    // mapping fails here rather than in production.
    for (const status of WORKFLOW_STATUSES) {
      expect(mediaJobStateFromWorkflow(status)).toBeTypeOf('string');
    }
  });

  it('treats an undocumented status as a failure rather than as progress', () => {
    // The important assertion in this file. A state we cannot interpret must end the poll, because
    // the alternative is an indefinite spinner on a job whose outcome nobody knows.
    expect(mediaJobStateFromWorkflow('somethingNewFromThePlatform')).toBe('failed');
    expect(isTerminalMediaJobState(mediaJobStateFromWorkflow('somethingNew'))).toBe(true);
  });

  it('never reports a queued job as running', () => {
    // A visitor reads "running" as "my money is being spent". A queued job has not started, so
    // conflating the two would misreport cost as much as progress.
    expect(mediaJobStateFromWorkflow('queued')).not.toBe('running');
  });

  it('maps exactly the statuses that cannot change to terminal states', () => {
    const terminal = WORKFLOW_STATUSES.filter((status) =>
      isTerminalMediaJobState(mediaJobStateFromWorkflow(status))
    );

    // `unknown` is terminal here by choice rather than by the platform's definition, for the reason
    // asserted above.
    expect([...terminal].sort()).toEqual(['complete', 'errored', 'terminated', 'unknown']);
  });
});

describe('isKnownWorkflowStatus', () => {
  it('accepts every documented status', () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(isKnownWorkflowStatus(status)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isKnownWorkflowStatus('finished')).toBe(false);
    expect(isKnownWorkflowStatus('')).toBe(false);
  });
});

describe('video step policies', () => {
  it('disables retries on the inference step', () => {
    // The single most important assertion in this phase. Workflow steps retry by default — five
    // attempts with backoff — and this step bills per second of generated video. An inherited
    // default would turn one transient provider fault into several charges, and nothing about the
    // panel's behaviour would look wrong while it happened. No functional test would catch it,
    // which is exactly why the policy is a constant with an assertion against it.
    expect(VIDEO_INFERENCE_STEP_POLICY.retries.limit).toBe(0);
  });

  it('keeps retries on the cheap, idempotent storage step', () => {
    // The deliberate contrast: fetching a URL and writing it to a fixed key costs nothing to
    // repeat, and it is the step most exposed to a transient network fault.
    expect(VIDEO_STORAGE_STEP_POLICY.retries.limit).toBeGreaterThan(0);
  });

  it('bounds both steps with a timeout', () => {
    // A step with no timeout could occupy an instance indefinitely if a provider never answered.
    expect(VIDEO_INFERENCE_STEP_POLICY.timeout).toBeDefined();
    expect(VIDEO_STORAGE_STEP_POLICY.timeout).toBeDefined();
  });
});
