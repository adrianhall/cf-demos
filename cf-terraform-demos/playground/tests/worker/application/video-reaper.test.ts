/**
 * @file Tests for the scheduled video reaper, phase 18's answer to the expiry phase 8 deliberately
 *   deferred. The age cases are driven from an injected clock and from {@link VIDEO_RETENTION_MS}
 *   itself rather than from a hard-coded duplicate of it. That is deliberate and is the difference
 *   between a test that documents the policy and one that merely restates a number: if the
 *   retention window is changed, these tests must still pass, because what they assert is "older
 *   than the constant is collected" rather than "older than a day is collected". A test carrying
 *   its own copy of the figure would keep passing while the README, the UI, and the reaper drifted
 *   apart — which is the exact failure the single-constant rule exists to prevent. The suite stays
 *   offline and instant: nothing waits, and the storage port is a double.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VIDEO_RETENTION_HOURS } from '../../../src/shared/create-video';
import {
  REAP_BUDGET,
  VIDEO_RETENTION_MS,
  VideoReaper
} from '../../../src/worker/application/media/video-reaper';
import type {
  ExpirableVideoObject,
  VideoStoragePort
} from '../../../src/worker/application/ports/video-storage-port';
import { GENERATED_VIDEO_PREFIX } from '../../../src/worker/domain/media-job-identity';

/**
 * A fixed instant, so every age below is exact rather than dependent on when the suite runs.
 */
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Records every log a run emitted, so a test can assert on what was _not_ logged.
 *
 * @returns The recorded entries, a logger writing into them, and their serialised form.
 */
function createRecorder(): {
  entries: { level: string; message: string; context?: Record<string, unknown> }[];
  logger: {
    warn: (m: string, c?: Record<string, unknown>) => void;
    error: (m: string, c?: Record<string, unknown>) => void;
  };
  text: () => string;
} {
  const entries: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  return {
    entries,
    logger: {
      warn: (message, context) => {
        entries.push({ level: 'warn', message, context });
      },
      error: (message, context) => {
        entries.push({ level: 'error', message, context });
      }
    },
    text: () => JSON.stringify(entries)
  };
}

/**
 * Builds a storage double holding the given objects.
 *
 * Its `listExpired` applies the same cutoff-and-budget contract the real adapter promises, so a
 * reaper that asked for the wrong cutoff would see the wrong objects here too.
 *
 * @param objects Everything in the bucket, with its stored timestamp.
 * @param overrides Methods to replace, used to make a delete fail.
 * @returns A storage port double and the keys it has deleted.
 */
function storageOf(
  objects: ExpirableVideoObject[],
  overrides: Partial<VideoStoragePort> = {}
): { storage: VideoStoragePort; deleted: string[]; cutoffs: Date[]; limits: number[] } {
  const deleted: string[] = [];
  const cutoffs: Date[] = [];
  const limits: number[] = [];

  const storage = {
    store: vi.fn(),
    read: vi.fn(),
    readHead: vi.fn(),
    delete: async (key: string): Promise<void> => {
      // The containment guarantee is the adapter's, so the double enforces it too: a reaper that
      // asked to delete something outside the prefix must fail here rather than quietly pass.
      if (!key.startsWith(GENERATED_VIDEO_PREFIX)) {
        throw new Error(`Refusing to operate on "${key}": not a generated-video object key.`);
      }
      deleted.push(key);
    },
    listExpired: async (olderThan: Date, limit: number): Promise<ExpirableVideoObject[]> => {
      cutoffs.push(olderThan);
      limits.push(limit);
      return objects
        .filter((object) => object.uploaded.getTime() < olderThan.getTime())
        .sort((left, right) => left.uploaded.getTime() - right.uploaded.getTime())
        .slice(0, limit);
    },
    ...overrides
  } as unknown as VideoStoragePort;

  return { storage, deleted, cutoffs, limits };
}

/**
 * Builds an object stored a given age ago.
 *
 * @param ageMs How long before {@link NOW} it was stored.
 * @param name Key suffix, so keys are distinguishable.
 * @returns The object record.
 */
function aged(ageMs: number, name: string): ExpirableVideoObject {
  return { key: `${GENERATED_VIDEO_PREFIX}${name}`, uploaded: new Date(NOW - ageMs) };
}

/**
 * Builds a reaper over the given storage with a frozen clock.
 *
 * @param storage The storage port.
 * @param logger The diagnostic logger.
 * @returns The reaper under test.
 */
function reaperOver(storage: VideoStoragePort, logger = createRecorder().logger): VideoReaper {
  return new VideoReaper({ storage, logger, now: () => NOW });
}

describe('collecting expired video', () => {
  // The boundary, decided by the constant rather than by a duplicate of it. One object is a
  // minute past the window and one a minute short of it, so changing the retention window leaves
  // this test meaningful instead of merely passing.
  it('deletes an object past the retention age and keeps one within it', async () => {
    const old = aged(VIDEO_RETENTION_MS + 60_000, 'old');
    const young = aged(VIDEO_RETENTION_MS - 60_000, 'young');
    const { storage, deleted } = storageOf([old, young]);

    const summary = await reaperOver(storage).reap();

    expect(deleted).toEqual([old.key]);
    expect(summary.deleted).toBe(1);
  });

  // Exactly at the window. `listExpired` is documented as strictly-before, so an object whose age
  // is precisely the retention period is kept — asserted because "older than" and "at least as
  // old as" are a one-character change that no other test would notice.
  it('keeps an object exactly at the retention age', async () => {
    const { storage, deleted } = storageOf([aged(VIDEO_RETENTION_MS, 'exact')]);

    const summary = await reaperOver(storage).reap();

    expect(deleted).toEqual([]);
    expect(summary.deleted).toBe(0);
  });

  it('asks for a cutoff derived from the retention constant', async () => {
    const { storage, cutoffs } = storageOf([]);

    await reaperOver(storage).reap();

    expect(cutoffs[0]?.getTime()).toBe(NOW - VIDEO_RETENTION_MS);
  });

  it('reports the age of the oldest object it collected', async () => {
    const { storage } = storageOf([
      aged(VIDEO_RETENTION_MS + 60_000, 'newer'),
      aged(VIDEO_RETENTION_MS * 5, 'oldest')
    ]);

    const summary = await reaperOver(storage).reap();

    // The signal that the schedule is falling behind: an oldest age far beyond the window means
    // objects are waiting much longer than the stated policy.
    expect(summary.oldestAgeMs).toBe(VIDEO_RETENTION_MS * 5);
  });

  it('reports no oldest age when it collected nothing', async () => {
    const { storage } = storageOf([aged(60_000, 'fresh')]);

    const summary = await reaperOver(storage).reap();

    expect(summary.deleted).toBe(0);
    expect(summary.oldestAgeMs).toBeUndefined();
  });

  it('does nothing against an empty bucket', async () => {
    const { storage, deleted } = storageOf([]);

    const summary = await reaperOver(storage).reap();

    expect(deleted).toEqual([]);
    expect(summary).toMatchObject({ deleted: 0, examined: 0, budgetExhausted: false });
  });
});

describe('the per-invocation budget', () => {
  it('asks storage for no more than the budget', async () => {
    const { storage, limits } = storageOf([]);

    await reaperOver(storage).reap();

    expect(limits[0]).toBe(REAP_BUDGET);
  });

  // A cron invocation has a fifteen-minute wall clock, and a reaper that tried to drain an
  // arbitrarily large backlog would fail exactly when there is most to clean up.
  it('stops at the budget and says so when the backlog is larger', async () => {
    const backlog = Array.from({ length: REAP_BUDGET + 50 }, (_unused, index) =>
      aged(VIDEO_RETENTION_MS + index + 1, `object-${index}`)
    );
    const { storage, deleted } = storageOf(backlog);

    const summary = await reaperOver(storage).reap();

    expect(deleted).toHaveLength(REAP_BUDGET);
    // The only signal that the schedule is too slow for the rate of generation. Without it the
    // reaper fails silently by simply never catching up.
    expect(summary.budgetExhausted).toBe(true);
  });

  it('reports an unexhausted budget when the backlog fits', async () => {
    const { storage } = storageOf([aged(VIDEO_RETENTION_MS + 1, 'one')]);

    const summary = await reaperOver(storage).reap();

    expect(summary.budgetExhausted).toBe(false);
  });

  it('stays below R2\u2019s thousand-key ceiling for one list and one delete', () => {
    expect(REAP_BUDGET).toBeLessThanOrEqual(1000);
  });
});

describe('the retention window is stated once', () => {
  // Phase 8 refused to let the UI claim an expiry because nothing enforced one. Phase 18 lifts
  // that in one direction only: the panels may state a figure *because* the reaper enforces it.
  // What keeps that true over time is that there is a single number, so this asserts the
  // derivation rather than the value.
  it('derives the reaper window from the figure the panels display', () => {
    expect(VIDEO_RETENTION_MS).toBe(VIDEO_RETENTION_HOURS * 60 * 60 * 1000);
  });

  // The failure this prevents is a panel hard-coding "24 hours" in prose. That reads correctly
  // today and becomes a false promise the moment the constant changes — and a false retention
  // promise is the one claim phase 8 identified as worse than saying nothing.
  it('is quoted by both video panels from the shared constant rather than in prose', async () => {
    const views = await Promise.all(
      ['src/client/views/CreateVideoView.vue', 'src/client/views/AnimateImageView.vue'].map(
        async (relative) => readFile(path.join(demoRoot, relative), 'utf8')
      )
    );

    for (const view of views) {
      expect(view).toContain('VIDEO_RETENTION_HOURS');
      // A literal hour count in visitor-facing prose would be the duplicate this exists to stop.
      expect(view).not.toMatch(/\b24 hours\b/u);
      // The phase 8 wording, which is now false: something does delete it.
      expect(view).not.toMatch(/deletes it automatically yet|not\s+deleted automatically yet/u);
    }
  });
});

describe('prefix confinement', () => {
  // Paired with the phase 8 write guard: that one proves nothing else is written to the bucket,
  // this proves nothing else is deleted from it. A future user of the bucket must not have its
  // objects collected by a job that predates it.
  it('refuses a key outside the video prefix even when it is old enough', async () => {
    const foreign = {
      key: 'something-else/old.bin',
      uploaded: new Date(NOW - VIDEO_RETENTION_MS * 10)
    };
    const recorder = createRecorder();
    const { storage, deleted } = storageOf([foreign]);

    const summary = await reaperOver(storage, recorder.logger).reap();

    expect(deleted).toEqual([]);
    expect(summary.deleted).toBe(0);
    expect(recorder.entries[0]?.message).toBe('video_reaper_delete_failed');
  });
});

describe('resilience', () => {
  // One object that cannot be removed should not strand the rest of the backlog behind it.
  it('skips a failed delete and continues with the rest', async () => {
    const first = aged(VIDEO_RETENTION_MS + 3000, 'first');
    const second = aged(VIDEO_RETENTION_MS + 2000, 'second');
    const third = aged(VIDEO_RETENTION_MS + 1000, 'third');
    const deleted: string[] = [];
    const { storage } = storageOf([first, second, third], {
      delete: async (key: string): Promise<void> => {
        if (key === second.key) {
          throw new Error('concurrent cancellation already removed it');
        }
        deleted.push(key);
      }
    });

    const summary = await reaperOver(storage).reap();

    expect(deleted).toEqual([first.key, third.key]);
    // Counts what was achieved rather than what was attempted, so a partially failing run reports
    // the truth.
    expect(summary.deleted).toBe(2);
    expect(summary.examined).toBe(3);
  });

  it('logs the cause of a failed delete', async () => {
    const recorder = createRecorder();
    const { storage } = storageOf([aged(VIDEO_RETENTION_MS + 1, 'doomed')], {
      delete: async (): Promise<void> => {
        throw new Error('R2 is unavailable');
      }
    });

    await reaperOver(storage, recorder.logger).reap();

    expect(recorder.entries[0]?.context?.errorMessage).toBe('R2 is unavailable');
  });
});

describe('what the reaper must never log', () => {
  // An object key is derived from a verified email and a run identifier, so a key is identifying
  // and falls under the same rule as the email. Written as "must not contain", because that is
  // the direction that silently rots.
  it('logs no object key, even when a delete fails', async () => {
    const recorder = createRecorder();
    const doomed = aged(VIDEO_RETENTION_MS + 1, 'a1b2c3d4e5f6');
    const { storage } = storageOf([doomed], {
      delete: async (): Promise<void> => {
        throw new Error('nope');
      }
    });

    await reaperOver(storage, recorder.logger).reap();

    const text = recorder.text();
    expect(text).not.toContain('a1b2c3d4e5f6');
    expect(text).not.toContain(doomed.key);
    expect(text).not.toContain(GENERATED_VIDEO_PREFIX);
  });

  it('logs no key on a successful run', async () => {
    const recorder = createRecorder();
    const { storage } = storageOf([aged(VIDEO_RETENTION_MS + 1, 'deadbeef')]);

    await reaperOver(storage, recorder.logger).reap();

    expect(recorder.text()).not.toContain('deadbeef');
  });
});
