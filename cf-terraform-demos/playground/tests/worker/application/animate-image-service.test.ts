/**
 * @file Tests for the Animate Image use case. Two concerns dominate, and both are about _reuse_
 *   rather than about new behaviour. **The job adapter contracts are the ones Create Video
 *   established, and this panel must honour them identically.** Ownership is proved by recomputing
 *   the derived identifier from the identity on the current request, so a visitor asking after
 *   another's run finds nothing — written as "must not see" rather than "must be refused", because
 *   the correct answer is indistinguishable from absence. These are the security tests for the
 *   whole panel. **The two panels share one bucket and one derivation key, which makes a
 *   cross-panel collision worth proving impossible.** Both derive their storage key the same way
 *   from the same inputs, so a test pins that one visitor's two runs are distinct objects and that
 *   neither panel can reach into the other's job through a shared port. The insufficient-credit
 *   path gets its own coverage here because it is the _expected_ outcome for this panel on an
 *   account without prepaid AI Gateway credit — every image-to-video model is third-party — rather
 *   than an exotic failure.
 */

import { describe, expect, it } from 'vitest';
import { AnimateImageService } from '../../../src/worker/application/animate-image/animate-image-service';
import type {
  MediaJobPort,
  MediaJobStatus
} from '../../../src/worker/application/ports/media-job-port';
import type { VideoStoragePort } from '../../../src/worker/application/ports/video-storage-port';
import { validateAnimateImageRequest } from '../../../src/worker/domain/animate-image';
import { deriveMediaJobId, videoObjectKey } from '../../../src/worker/domain/media-job-identity';
import { encodeFailureReason } from '../../../src/worker/domain/provider-failures';
import { pngBase64 } from '../support/image-fixtures';

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * A second run identifier, for proving two runs do not share an object.
 */
const OTHER_RUN_ID = '3f0e5c21-8888-4999-8aaa-bbbbccccdddd';

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
    imageBase64: pngBase64(),
    model: 'alibaba/hh1.1-i2v',
    runId: RUN_ID,
    motionPrompt: 'a slow push in',
    resolution: '720P',
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
 * @returns The port, its backing map, and the identifiers it was asked to start.
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
function storagePort(head?: Uint8Array): { port: VideoStoragePort; deleted: string[] } {
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
          mediaType: 'video/mp4' as const,
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
function runRepository(): {
  port: { save: (record: { runId: string }) => Promise<void>; find: (runId: string) => never };
  records: Map<string, unknown>;
} {
  const records = new Map<string, unknown>();
  return {
    records,
    port: {
      async save(record: { runId: string }) {
        records.set(record.runId, record);
      },
      find(runId: string) {
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

/**
 * Builds a service over the supplied doubles.
 *
 * @param parts Ports to use; any omitted one is defaulted to an empty double.
 * @returns The service under test.
 */
function buildService(parts: {
  jobs?: MediaJobPort;
  storage?: VideoStoragePort;
  runs?: ReturnType<typeof runRepository>['port'];
}): AnimateImageService {
  return new AnimateImageService({
    jobs: parts.jobs ?? jobPort().port,
    storage: parts.storage ?? storagePort().port,
    runs: (parts.runs ?? runRepository().port) as never,
    jobIdKey: KEY
  });
}

describe('AnimateImageService.accept', () => {
  it('starts a job and echoes the applied controls with the verified source facts', async () => {
    const jobs = jobPort();
    const service = buildService({ jobs: jobs.port });

    const accepted = await service.accept(validateAnimateImageRequest(body()), body(), ALICE);

    expect(accepted.state).toBe('accepted');
    expect(accepted.runId).toBe(RUN_ID);
    expect(accepted.applied.resolution).toBe('720P');
    expect(accepted.applied.estimateKnown).toBe(true);
    expect(accepted.applied.estimatedCostUsd).toBeCloseTo(0.7, 10);
    // The facts the side-by-side layout renders beside the video, read from the picture's bytes.
    expect(accepted.applied.source.mediaType).toBe('image/png');
  });

  it('records the run before the job starts', async () => {
    // A record written only on completion would leave a failed or cancelled job with no owner on
    // file, and the metrics route's ownership check with nothing to compare against.
    const runs = runRepository();
    await buildService({ runs: runs.port }).accept(
      validateAnimateImageRequest(body()),
      body(),
      ALICE
    );

    expect(runs.records.get(RUN_ID)).toMatchObject({
      task: 'animate-image',
      ownerEmail: ALICE.email,
      status: 'running'
    });
  });

  it('carries the picture into the job rather than storing it', async () => {
    // Phase 8's Finding 10, asserted for this panel: the bytes travel in the job's parameters and
    // nothing is written to the bucket at acceptance.
    const started: unknown[] = [];
    const storage = storagePort();
    const service = new AnimateImageService({
      jobs: {
        async start(_jobId, params) {
          started.push(params);
        },
        async status() {
          return undefined;
        },
        async cancel() {
          return false;
        }
      },
      storage: storage.port,
      runs: runRepository().port as never,
      jobIdKey: KEY
    });

    await service.accept(validateAnimateImageRequest(body()), body(), ALICE);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ request: { imageBase64: expect.any(String) } });
    expect(storage.deleted).toEqual([]);
  });

  it('refuses a second job for the same run identifier', async () => {
    const jobs = jobPort();
    const service = buildService({ jobs: jobs.port });

    await service.accept(validateAnimateImageRequest(body()), body(), ALICE);

    await expect(
      service.accept(validateAnimateImageRequest(body()), body(), ALICE)
    ).rejects.toThrow(/A job for this run already exists/u);
  });

  it('derives a different job for each identity', async () => {
    // The ownership guarantee at its root: two visitors using the same run identifier cannot
    // collide, because the identifier is a keyed hash of the verified email and the run.
    const jobs = jobPort();
    const service = buildService({ jobs: jobs.port });

    await service.accept(validateAnimateImageRequest(body()), body(), ALICE);
    await service.accept(validateAnimateImageRequest(body()), body(), BOB);

    expect(jobs.started).toHaveLength(2);
    expect(jobs.started[0]).not.toBe(jobs.started[1]);
  });
});

describe('AnimateImageService.status', () => {
  it('reports a job to its owner', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({ jobs: jobPort({ [jobId]: { state: 'running' } }).port });

    expect(await service.status(RUN_ID, ALICE)).toEqual({ runId: RUN_ID, state: 'running' });
  });

  it('does not let another identity see the job', async () => {
    // Written as absence rather than refusal: confirming the job exists would itself be the
    // disclosure the derivation exists to prevent.
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({ jobs: jobPort({ [jobId]: { state: 'running' } }).port });

    expect(await service.status(RUN_ID, BOB)).toBeUndefined();
  });

  it('reports an unknown run as absent', async () => {
    expect(await buildService({}).status(RUN_ID, ALICE)).toBeUndefined();
  });

  // The expected failure for this panel rather than an exotic one: every image-to-video model is
  // third-party, so an account with no prepaid AI Gateway credit fails exactly here, and the
  // classification is what lets the UI say "top up" instead of "try again".
  it('decodes an insufficient-credit failure the Workflow classified', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({
      jobs: jobPort({
        [jobId]: { state: 'failed', error: encodeFailureReason('insufficient-credit') }
      }).port
    });

    expect(await service.status(RUN_ID, ALICE)).toEqual({
      runId: RUN_ID,
      state: 'failed',
      reason: 'insufficient-credit'
    });
  });

  it('reports a provider failure the Workflow classified', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({
      jobs: jobPort({
        [jobId]: { state: 'failed', error: encodeFailureReason('provider-failure') }
      }).port
    });

    expect((await service.status(RUN_ID, ALICE))?.reason).toBe('provider-failure');
  });

  it('treats an unrecognised error message as a generic provider failure', async () => {
    // A message this demo did not write is a provider's own text, and must not reach a visitor.
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({
      jobs: jobPort({
        [jobId]: { state: 'failed', error: 'upstream exploded at 0x41 for account 12345' }
      }).port
    });

    const status = await service.status(RUN_ID, ALICE);

    expect(status?.reason).toBe('provider-failure');
    expect(JSON.stringify(status)).not.toContain('exploded');
  });

  it('reports a completed job with a receipt and the applied controls', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({
      jobs: jobPort({
        [jobId]: {
          state: 'completed',
          output: {
            mediaType: 'video/mp4',
            byteLength: 2_048,
            logIds: ['log-1'],
            elapsedMs: 1_000,
            applied: {
              model: 'alibaba/hh1.1-i2v',
              resolution: '720P',
              duration: 5,
              source: { mediaType: 'image/png', byteLength: 100, width: 64, height: 64 },
              estimatedCostUsd: 0.7,
              estimateKnown: true
            }
          }
        }
      }).port
    });

    const status = await service.status(RUN_ID, ALICE);

    expect(status?.state).toBe('completed');
    expect(status?.video).toEqual({ mediaType: 'video/mp4', byteLength: 2_048 });
    expect(status?.receipt?.task).toBe('animate-image');
    expect(status?.receipt?.gatewayRouted).toBe(true);
    expect(status?.applied?.source.width).toBe(64);
  });

  it.each([
    ['null output', null],
    ['a non-object output', 'done'],
    [
      'an output missing its applied controls',
      { mediaType: 'video/mp4', byteLength: 1, logIds: [], elapsedMs: 1 }
    ],
    [
      'an output whose applied controls lack the source facts',
      {
        mediaType: 'video/mp4',
        byteLength: 1,
        logIds: [],
        elapsedMs: 1,
        applied: { model: 'alibaba/hh1.1-i2v', resolution: '720P', duration: 5 }
      }
    ]
  ])('fails a completed job reporting %s rather than throwing', async (_label, output) => {
    // A Workflow's output is `unknown` by contract. Dereferencing a half-populated one would throw
    // at the point of use and surface as an opaque `500`, which is how the equivalent Create Video
    // defect reached production.
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const service = buildService({
      jobs: jobPort({ [jobId]: { state: 'completed', output } }).port
    });

    expect(await service.status(RUN_ID, ALICE)).toEqual({
      runId: RUN_ID,
      state: 'failed',
      reason: 'provider-failure'
    });
  });
});

describe('AnimateImageService.read', () => {
  it('serves a stored video to its owner', async () => {
    const service = buildService({ storage: storagePort(mp4Head()).port });

    expect(await service.read(RUN_ID, ALICE)).toBeDefined();
  });

  it('refuses stored bytes that are not a playable video', async () => {
    // Verified on the read path independently of whatever verified them at store time: this is the
    // path facing a browser from this demo's own authenticated origin.
    const service = buildService({ storage: storagePort(new Uint8Array(1_024)).port });

    await expect(service.read(RUN_ID, ALICE)).rejects.toThrow(/not a video this demo will play/u);
  });

  it('reports an absent object as absent', async () => {
    expect(await buildService({ storage: storagePort().port }).read(RUN_ID, ALICE)).toBeUndefined();
  });
});

describe('AnimateImageService.cancel', () => {
  it('terminates the job and deletes anything it stored', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const storage = storagePort();
    const service = buildService({
      jobs: jobPort({ [jobId]: { state: 'running' } }).port,
      storage: storage.port
    });

    expect(await service.cancel(RUN_ID, ALICE)).toBe(true);
    expect(storage.deleted).toEqual([videoObjectKey(jobId)]);
  });

  it('still deletes when no instance was found, because the two can race', async () => {
    // A job that finished between the visitor deciding to cancel and this call arriving has
    // already written its object; leaving it behind would be an orphan nothing collects.
    const storage = storagePort();
    const service = buildService({ storage: storage.port });

    expect(await service.cancel(RUN_ID, ALICE)).toBe(false);
    expect(storage.deleted).toHaveLength(1);
  });

  it('does not let another identity cancel a job', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const jobs = jobPort({ [jobId]: { state: 'running' } });
    const service = buildService({ jobs: jobs.port });

    expect(await service.cancel(RUN_ID, BOB)).toBe(false);
    expect(jobs.jobs.get(jobId)?.state).toBe('running');
  });
});

describe('job adapter reuse', () => {
  // Both panels write into one bucket under one prefix with one derivation key, which is the
  // reuse the phase requires. That makes it worth proving the shared key space does not collide:
  // one visitor's two runs must be two objects, or a second animation would overwrite the first.
  it('gives each of one visitor\u2019s runs a distinct storage key', async () => {
    const first = videoObjectKey(await deriveMediaJobId(ALICE.email, RUN_ID, KEY));
    const second = videoObjectKey(await deriveMediaJobId(ALICE.email, OTHER_RUN_ID, KEY));

    expect(first).not.toBe(second);
    expect(first.startsWith('generated-video/')).toBe(true);
    expect(second.startsWith('generated-video/')).toBe(true);
  });

  // The same derivation as Create Video, which is what lets one scheduled reaper collect both
  // panels' output from one prefix. A second scheme would create objects outside its reach.
  it('stores under the same prefix Create Video uses', async () => {
    const jobId = await deriveMediaJobId(ALICE.email, RUN_ID, KEY);
    const storage = storagePort();
    await buildService({ storage: storage.port }).cancel(RUN_ID, ALICE);

    expect(storage.deleted[0]).toBe(`generated-video/${jobId}`);
  });
});
