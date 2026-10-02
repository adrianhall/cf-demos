/**
 * @file Tests for the Workflows-backed job adapter. These exist because of a production defect
 *   found by reading deployed logs. `Workflow.get()` throws when an instance is absent, which this
 *   adapter already handled — but `WorkflowInstance.status()` throws in its own right, and does so
 *   precisely when a job has _failed_. That call sat outside the `try`, so every poll of a failed
 *   job became an unhandled throw: a `500` carrying "An unexpected error occurred", which is the
 *   exact uninformative answer the panel's failure classification was built to avoid. The lesson
 *   generalises past this adapter: a binding that signals one condition by throwing is likely to
 *   signal others the same way, so each call needs its own handling rather than one `try` around
 *   the lookup.
 */

import { describe, expect, it, vi } from 'vitest';
import { WorkflowMediaJobs } from '../../../src/worker/infrastructure/jobs/workflow-media-jobs';

/**
 * A derived job identifier of the shape the service produces.
 */
const JOB_ID = 'a'.repeat(64);

/**
 * Builds a Workflow binding double.
 *
 * @param instance The instance `get` resolves to, or an error to throw.
 * @returns A `Workflow`-shaped object.
 */
function binding(instance: unknown): Workflow {
  return {
    get: vi.fn(async () => {
      if (instance instanceof Error) {
        throw instance;
      }
      return instance;
    }),
    create: vi.fn(async () => ({}))
  } as unknown as Workflow;
}

/**
 * Captures log lines.
 *
 * @returns The logger and its captured entries.
 */
function capture() {
  const entries: { message: string; context?: Record<string, unknown> }[] = [];
  return {
    entries,
    logger: {
      warn: (message: string, context?: Record<string, unknown>) =>
        entries.push({ message, context }),
      error: (message: string, context?: Record<string, unknown>) =>
        entries.push({ message, context })
    }
  };
}

describe('WorkflowMediaJobs.status', () => {
  it('translates a readable status', async () => {
    const jobs = new WorkflowMediaJobs(
      binding({ status: vi.fn(async () => ({ status: 'running' })) })
    );

    expect(await jobs.status(JOB_ID)).toEqual({ state: 'running' });
  });

  it('reports an absent instance as undefined rather than throwing', async () => {
    // Absence is how the ownership check expresses itself: an identifier derived from a different
    // identity simply does not exist, and the route answers `404`.
    const jobs = new WorkflowMediaJobs(binding(new Error('instance not found')));

    expect(await jobs.status(JOB_ID)).toBe(undefined);
  });

  // The regression test for the deployed `500`. Before this, a failed job's poll threw.
  it('reports a failed job rather than throwing when its status cannot be read', async () => {
    const { logger, entries } = capture();
    const jobs = new WorkflowMediaJobs(
      binding({
        status: vi.fn(async () => {
          throw new Error('instance is in an errored state');
        })
      }),
      logger
    );

    const status = await jobs.status(JOB_ID);

    // Failed, not `undefined`: the job exists, so reporting absence would make the route answer
    // `404` for a job the visitor had legitimately started.
    expect(status).toEqual({ state: 'failed' });
    const line = entries.find((entry) => entry.message === 'media_job_status_unreadable');
    expect(line?.context?.['cause']).toContain('errored state');
  });

  it('never logs the derived job identifier, which is identifying', async () => {
    // The identifier is a function of a verified email, so it falls under the same rule as the
    // email itself.
    const { logger, entries } = capture();
    const jobs = new WorkflowMediaJobs(
      binding({
        status: vi.fn(async () => {
          throw new Error('boom');
        })
      }),
      logger
    );

    await jobs.status(JOB_ID);

    expect(JSON.stringify(entries)).not.toContain(JOB_ID);
  });

  it('passes through an instance error message for classification', async () => {
    const jobs = new WorkflowMediaJobs(
      binding({
        status: vi.fn(async () => ({
          status: 'errored',
          error: { name: 'Error', message: 'playground-failure:insufficient-credit' }
        }))
      })
    );

    expect(await jobs.status(JOB_ID)).toMatchObject({
      state: 'failed',
      error: 'playground-failure:insufficient-credit'
    });
  });
});

describe('WorkflowMediaJobs.cancel', () => {
  it('terminates an existing instance', async () => {
    const terminate = vi.fn(async () => undefined);
    const jobs = new WorkflowMediaJobs(binding({ terminate }));

    expect(await jobs.cancel(JOB_ID)).toBe(true);
    expect(terminate).toHaveBeenCalled();
  });

  it('reports no instance to cancel', async () => {
    const jobs = new WorkflowMediaJobs(binding(new Error('not found')));

    expect(await jobs.cancel(JOB_ID)).toBe(false);
  });
});
