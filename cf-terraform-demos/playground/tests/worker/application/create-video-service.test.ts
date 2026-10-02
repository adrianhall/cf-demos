/**
 * @file Tests for the Create Video use case, and principally for its ownership behaviour. This
 *   panel stores no owner column. The job identifier is derived from the verified email and the run
 *   identifier, so the service recomputes it from the identity on the current request — and a
 *   visitor asking after someone else's run finds nothing. That makes the cross-identity assertions
 *   here the security tests for the whole panel, and they are written as "must not see" rather than
 *   "must be refused", because the correct answer is indistinguishable from absence.
 */

import { describe, expect, it } from 'vitest';
import { CreateVideoService } from '../../../src/worker/application/create-video/create-video-service';
import type {
  MediaJobPort,
  MediaJobStatus
} from '../../../src/worker/application/ports/media-job-port';
import type { VideoStoragePort } from '../../../src/worker/application/ports/video-storage-port';
import { validateCreateVideoRequest } from '../../../src/worker/domain/create-video';

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Stand-in for the Access audience tag used as keying material.
 */
const KEY = 'a'.repeat(64);

/**
 * Alice, the owner in every test below.
 */
const ALICE = { email: 'alice@example.com', sub: 'sub-alice' };

/**
 * Bob, who must never see Alice's job.
 */
const BOB = { email: 'bob@example.com', sub: 'sub-bob' };

/**
 * Builds a valid request body.
 *
 * @param overrides Fields to replace.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: 'A dog running',
    model: 'pixverse/v6',
    runId: RUN_ID,
    resolution: '360p',
    duration: 5,
    ...overrides
  };
}

/**
 * Builds an in-memory job port keyed by job identifier.
 *
 * Keyed by identifier rather than by run, deliberately: that is what lets a test prove two
 * identities derive different keys and therefore cannot reach one another's job.
 *
 * @param seed Initial job states.
 * @returns The port and its backing map.
 */
function jobPort(seed: Record<string, MediaJobStatus> = {}): {
  port: MediaJobPort;
  jobs: Map<string, MediaJobStatus>;
  started: string[];
} {
  const jobs = new Map<string, MediaJobStatus>(Object.entries(seed));
  const started: string[] = [];
  return {
    jobs,
    started,
    port: {
      async start(jobId) {
        if (jobs.has(jobId)) {
          throw new Error('already exists');
        }
        started.push(jobId);
        jobs.set(jobId, { state: 'accepted' });
      },
      async status(jobId) {
        return jobs.get(jobId);
      },
      async cancel(jobId) {
        if (!jobs.has(jobId)) {
          return false;
        }
        jobs.set(jobId, { state: 'cancelled' });
        return true;
      }
    }
  };
}

/**
 * Builds a storage double.
 *
 * @param head Bytes `readHead` reports, or `undefined` for an absent object.
 * @returns The port and its recorded deletions.
 */
function storagePort(head?: Uint8Array): {
  port: VideoStoragePort;
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    port: {
      async store(_key, _body, mediaType) {
        return { mediaType, byteLength: 0 };
      },
      async read() {
        return {
          body: new ReadableStream(),
          mediaType: 'video/mp4',
          byteLength: 100,
          rangeOffset: 0,
          rangeLength: 100
        };
      },
      async readHead() {
        return head;
      },
      async delete(key) {
        deleted.push(key);
      },
      async listExpired() {
        return [];
      }
    }
  };
}

/**
 * Builds an in-memory run repository.
 *
 * @returns The port and its backing map.
 */
function runRepository() {
  const records = new Map<string, unknown>();
  return {
    records,
    port: {
      async save(record: { runId: string }) {
        records.set(record.runId, record);
      },
      async find(runId: string) {
        return records.get(runId) as never;
      }
    }
  };
}

/**
 * MP4-looking bytes, for the read path's independent verification.
 *
 * @returns A buffer identifying as MP4.
 */
function mp4Head(): Uint8Array {
  const bytes = new Uint8Array(1_024);
  bytes.set([0x00, 0x00, 0x00, 0x20], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
  return bytes;
}

describe('CreateVideoService.accept', () => {
  it('starts a job and echoes the applied controls', async () => {
    const jobs = jobPort();
    const storage = storagePort();
    const runs = runRepository();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storage.port,
      runs: runs.port,
      jobIdKey: KEY
    });

    const accepted = await service.accept(validateCreateVideoRequest(body()), body(), ALICE);

    expect(accepted.state).toBe('accepted');
    expect(accepted.runId).toBe(RUN_ID);
    expect(accepted.applied.resolution).toBe('360p');
    expect(accepted.applied.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('records the run before the job starts', async () => {
    // A record written only on completion would leave a failed or cancelled job with no owner on
    // file, and the metrics route's ownership check with nothing to compare against.
    const jobs = jobPort();
    const runs = runRepository();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runs.port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);

    expect(runs.records.get(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      ownerEmail: ALICE.email,
      task: 'create-video'
    });
  });

  it('derives different job identifiers for different identities', async () => {
    // The ownership guarantee, asserted at its source: the same run identifier from two visitors
    // must produce two distinct jobs rather than a collision.
    const jobs = jobPort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);
    await service.accept(validateCreateVideoRequest(body()), body(), BOB);

    expect(jobs.started).toHaveLength(2);
    expect(jobs.started[0]).not.toBe(jobs.started[1]);
  });

  it('reports a reused run identifier as a conflict', async () => {
    const jobs = jobPort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);

    await expect(
      service.accept(validateCreateVideoRequest(body()), body(), ALICE)
    ).rejects.toMatchObject({ problemDetails: { status: 409 } });
  });

  it('logs a start failure with its cause but without the prompt', async () => {
    const lines: { message: string; context?: Record<string, unknown> }[] = [];
    const service = new CreateVideoService({
      jobs: {
        async start() {
          throw new Error('binding unavailable');
        },
        async status() {
          return undefined;
        },
        async cancel() {
          return false;
        }
      },
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY,
      logger: {
        warn: (message, context) => lines.push({ message, context }),
        error: (message, context) => lines.push({ message, context })
      }
    });

    await expect(
      service.accept(validateCreateVideoRequest(body()), body(), ALICE)
    ).rejects.toMatchObject({ problemDetails: { status: 409 } });

    const failure = lines.find((line) => line.message === 'create_video_job_start_failed');
    // The cause is kept, because discarding it is the defect this repository's observability rules
    // exist to prevent.
    expect(failure?.context?.['cause']).toContain('binding unavailable');

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('A dog running');
    expect(serialised).not.toContain(ALICE.email);
  });
});

describe('CreateVideoService.status', () => {
  /**
   * Builds a service whose job store already holds Alice's completed job.
   *
   * @returns The service and the job identifier used.
   */
  async function withCompletedJob() {
    const jobs = jobPort();
    const runs = runRepository();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort(mp4Head()).port,
      runs: runs.port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);
    const jobId = jobs.started[0]!;
    jobs.jobs.set(jobId, {
      state: 'completed',
      output: {
        mediaType: 'video/mp4',
        byteLength: 2_048,
        logIds: ['log-1'],
        elapsedMs: 90_000,
        applied: {
          prompt: 'A dog running',
          model: 'pixverse/v6',
          resolution: '360p',
          aspectRatio: '16:9',
          duration: 5,
          estimatedCostUsd: 0.125
        }
      }
    });

    return { service, jobs, runs, jobId };
  }

  it('reports a completed job with its video, receipt, and applied controls', async () => {
    const { service } = await withCompletedJob();

    const status = await service.status(RUN_ID, ALICE);

    expect(status?.state).toBe('completed');
    expect(status?.video).toEqual({ mediaType: 'video/mp4', byteLength: 2_048 });
    expect(status?.receipt?.logIds).toEqual(['log-1']);
    expect(status?.receipt?.gatewayRouted).toBe(true);
    expect(status?.applied?.resolution).toBe('360p');
  });

  it('does not show one identity another’s job', async () => {
    // The security assertion for this panel. Bob derives a different identifier, so Alice's job is
    // simply not there — he is not told it exists and refused, which would itself be a disclosure.
    const { service } = await withCompletedJob();

    expect(await service.status(RUN_ID, BOB)).toBe(undefined);
  });

  it('reports an unknown run as absent', async () => {
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    expect(await service.status(RUN_ID, ALICE)).toBe(undefined);
  });

  it('records the gateway logs once the job has finished', async () => {
    // The record written at acceptance had no log identifiers, because the gateway call had not
    // happened yet. Without this second save, cost could never resolve for a video run.
    const { service, runs } = await withCompletedJob();

    await service.status(RUN_ID, ALICE);

    expect(runs.records.get(RUN_ID)).toMatchObject({ logIds: ['log-1'], status: 'completed' });
  });

  it('replaces a provider’s failure text with a fixed explanation', async () => {
    const jobs = jobPort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);
    jobs.jobs.set(jobs.started[0]!, {
      state: 'failed',
      error: 'upstream 500 from internal-host-7.provider.local request 0xdeadbeef'
    });

    const status = await service.status(RUN_ID, ALICE);

    // A provider's own text can name internal hosts and request identifiers, so it does not reach
    // the browser. It remains in the Workflow's own observability for whoever is diagnosing it.
    expect(status?.state).toBe('failed');
    expect(status?.error).not.toContain('internal-host-7');
    expect(status?.error).not.toContain('0xdeadbeef');
  });

  it('reports a completed job with no output as failed', async () => {
    const jobs = jobPort();
    const lines: string[] = [];
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY,
      logger: { warn: (message) => lines.push(message), error: (message) => lines.push(message) }
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);
    jobs.jobs.set(jobs.started[0]!, { state: 'completed' });

    const status = await service.status(RUN_ID, ALICE);

    expect(status?.state).toBe('failed');
    expect(lines).toContain('create_video_job_output_missing');
  });

  it.each(['accepted', 'running'] as const)('reports %s without a video', async (state) => {
    const jobs = jobPort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);
    jobs.jobs.set(jobs.started[0]!, { state });

    const status = await service.status(RUN_ID, ALICE);

    expect(status?.state).toBe(state);
    expect(status?.video).toBe(undefined);
  });
});

describe('CreateVideoService.read', () => {
  it('verifies the stored bytes before serving them', async () => {
    // The read path validates independently of the write path. An object trusted merely because
    // something stored it earlier would be trusted on the strength of a decision made elsewhere —
    // and this is the path that faces a browser from this demo's own authenticated origin.
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storagePort(new TextEncoder().encode('{"error":"nope"}')).port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await expect(service.read(RUN_ID, ALICE)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });
  });

  it('serves a verified video', async () => {
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storagePort(mp4Head()).port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    const served = await service.read(RUN_ID, ALICE);

    expect(served?.mediaType).toBe('video/mp4');
  });

  it('reports an absent video rather than failing', async () => {
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storagePort(undefined).port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    expect(await service.read(RUN_ID, ALICE)).toBe(undefined);
  });

  it('never logs the object key, which is identifying', async () => {
    // The key is a function of a verified email, so it falls under the same rule as the email
    // itself. The run identifier is enough to find the event.
    const lines: { message: string; context?: Record<string, unknown> }[] = [];
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storagePort(new TextEncoder().encode('not a video')).port,
      runs: runRepository().port,
      jobIdKey: KEY,
      logger: {
        warn: (message, context) => lines.push({ message, context }),
        error: (message, context) => lines.push({ message, context })
      }
    });

    await expect(service.read(RUN_ID, ALICE)).rejects.toThrow();

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('generated-video/');
    expect(serialised).not.toContain(ALICE.email);
  });
});

describe('CreateVideoService.cancel', () => {
  it('terminates the job and deletes anything stored', async () => {
    const jobs = jobPort();
    const storage = storagePort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storage.port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);

    expect(await service.cancel(RUN_ID, ALICE)).toBe(true);
    expect(storage.deleted).toHaveLength(1);
    expect(storage.deleted[0]).toMatch(/^generated-video\//u);
  });

  it('deletes even when no job was found', async () => {
    // Cancellation races a job that may have finished in the meantime. A job that completed between
    // the browser deciding to cancel and this call arriving has already written its object, and
    // leaving it behind would be exactly the orphan a reaper later has to collect.
    const storage = storagePort();
    const service = new CreateVideoService({
      jobs: jobPort().port,
      storage: storage.port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    expect(await service.cancel(RUN_ID, ALICE)).toBe(false);
    expect(storage.deleted).toHaveLength(1);
  });

  it('cannot cancel another identity’s job', async () => {
    const jobs = jobPort();
    const service = new CreateVideoService({
      jobs: jobs.port,
      storage: storagePort().port,
      runs: runRepository().port,
      jobIdKey: KEY
    });

    await service.accept(validateCreateVideoRequest(body()), body(), ALICE);

    // Bob derives a different identifier, so there is nothing for him to cancel — and Alice's job
    // is untouched.
    expect(await service.cancel(RUN_ID, BOB)).toBe(false);
    expect(jobs.jobs.get(jobs.started[0]!)?.state).toBe('accepted');
  });
});
