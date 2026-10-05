/**
 * @file The scheduled collector for generated video, which phase 8 deliberately deferred to phase 18.
 *   Phase 8 shipped storage with no expiry, and said so rather than inventing a retention window it
 *   would then have to change. That was sound while `pnpm teardown` was the only cleanliness
 *   obligation — teardown empties the bucket, so the account always ended clean. What it did not do
 *   is keep a _running_ demo clean, and this is the piece that does. Four decisions here are
 *   load-bearing, and each is the thing that separates a correct reaper from one that merely
 *   exists: **It is driven by the bucket, not by what the application remembers.** The objects most
 *   in need of collecting are exactly the ones nothing remembers: a Workflow instance whose state
 *   has aged out, or a run abandoned before it recorded anything. A reaper that deleted only
 *   objects it could still find a job for would leave precisely the orphans behind, while appearing
 *   to work. The authority is each object's own `uploaded` timestamp, read from R2 — never anything
 *   encoded in a key, which a future key-format change would quietly invalidate. **The work per
 *   invocation is bounded.** R2 lists at most 1000 keys and deletes at most 1000 per call, and a
 *   cron invocation has a fifteen-minute wall clock. A reaper that tried to drain an arbitrarily
 *   large backlog in one firing would fail at the worst possible moment — when there is most to
 *   clean up. Falling behind is recoverable; a handler that always times out is not. So there is a
 *   fixed budget, and the run reports whether it hit it. **It is confined to the video prefix.**
 *   The storage adapter refuses any key outside {@link GENERATED_VIDEO_PREFIX}, so a future user of
 *   this bucket cannot have its objects collected by a job that predates it. That pairs with the
 *   phase 8 write guard: one test proves nothing else is written there, this proves nothing else is
 *   deleted. **It logs a summary and never a key.** An object key is derived from a verified
 *   identity and a run identifier, so keys are identifying and fall under the same rule as the
 *   email. Counts, the oldest age collected, and whether the budget was hit are what a reader needs
 *   — and the last of those is the only signal that the schedule is too slow. Without it the reaper
 *   fails silently by simply never catching up.
 */

import { VIDEO_RETENTION_HOURS } from '../../../shared/create-video';
import type { DiagnosticLogger } from '../ports/diagnostic-logger-port';
import type { VideoStoragePort } from '../ports/video-storage-port';

/**
 * How long a generated video is kept before the reaper collects it.
 *
 * **Derived from {@link VIDEO_RETENTION_HOURS} rather than declared, which is the whole point.**
 * The figure appears in the README and in two panels, and the only way the stated policy and the
 * enforced one cannot drift apart is for there to be a single number. Writing `86_400_000` here
 * would have been clearer to read and would have let the UI say one thing while the reaper did
 * another — the exact failure phase 8 refused to risk when it declined to claim any expiry at all.
 *
 * Twenty-four hours is long enough that a presenter can generate a video, talk for an hour, and
 * still play it back, and short enough that a demo account does not accumulate media for weeks.
 */
export const VIDEO_RETENTION_MS = VIDEO_RETENTION_HOURS * 60 * 60 * 1000;

/**
 * Largest number of objects one scheduled invocation will delete.
 *
 * Below R2's 1000-key limit for both `list()` and a bulk `delete()`, so a full budget is still a
 * single round of calls rather than an unbounded loop. A backlog larger than this is collected over
 * successive firings, which is the recoverable failure mode; attempting the whole backlog at once
 * is not.
 */
export const REAP_BUDGET = 500;

/**
 * What one reaper run did.
 *
 * Returned as well as logged so a test can assert on the outcome without parsing log records, and
 * so a future operational endpoint could report it without the reaper having to change.
 */
export interface ReapSummary {
  /**
   * How many objects were deleted.
   */
  deleted: number;
  /**
   * Age in milliseconds of the oldest object collected, or `undefined` when none were.
   *
   * The number that says whether the schedule is keeping up: an oldest age far beyond the retention
   * window means objects are waiting much longer than the stated policy.
   */
  oldestAgeMs?: number;
  /**
   * Whether the run stopped because it hit {@link REAP_BUDGET} rather than because it ran out of
   * expired objects.
   *
   * `true` on a single run is unremarkable after a busy session. `true` on every run means the
   * schedule is too slow for the rate of generation, and this is the only signal of that.
   */
  budgetExhausted: boolean;
  /**
   * How many expired objects the run considered, which is `deleted` plus any that failed.
   */
  examined: number;
  /**
   * How long the run took, which is what a budget-exhausted run is measured against.
   */
  elapsedMs: number;
}

/**
 * Dependencies the reaper needs.
 */
export interface VideoReaperOptions {
  /**
   * Where generated video is stored. Its own prefix guard is what confines the deletions.
   */
  storage: VideoStoragePort;
  /**
   * Records the run summary and any failure.
   */
  logger: DiagnosticLogger;
  /**
   * Reads the current time.
   *
   * Injected so the age cases are tested against a fixed instant rather than by waiting, which
   * keeps the suite offline and instant.
   */
  now?: () => number;
}

/**
 * Deletes generated video older than the retention window.
 */
export class VideoReaper {
  readonly #storage: VideoStoragePort;
  readonly #logger: DiagnosticLogger;
  readonly #now: () => number;

  /**
   * @param options Storage, logger, and optional clock; see {@link VideoReaperOptions}.
   */
  constructor(options: VideoReaperOptions) {
    this.#storage = options.storage;
    this.#logger = options.logger;
    this.#now = options.now ?? ((): number => Date.now());
  }

  /**
   * Collects every expired object up to the per-invocation budget.
   *
   * A delete that fails is logged and skipped rather than aborting the run: one object that cannot
   * be removed — because a concurrent cancellation already removed it, say — should not strand the
   * rest of the backlog behind it. The summary therefore counts objects actually deleted, not
   * objects attempted, so a partially failing run reports what it really achieved.
   *
   * @returns What the run did; see {@link ReapSummary}.
   */
  async reap(): Promise<ReapSummary> {
    const startedAt = this.#now();
    const cutoff = new Date(startedAt - VIDEO_RETENTION_MS);

    const expired = await this.#storage.listExpired(cutoff, REAP_BUDGET);

    let deleted = 0;
    let oldestAgeMs: number | undefined;

    for (const object of expired) {
      try {
        await this.#storage.delete(object.key);
        deleted += 1;

        // The list arrives oldest first, so the first successful delete is the oldest. Recorded
        // from the object rather than assumed from position, because the ordering is the
        // adapter's promise and this does not need to depend on it.
        const ageMs = startedAt - object.uploaded.getTime();
        if (oldestAgeMs === undefined || ageMs > oldestAgeMs) {
          oldestAgeMs = ageMs;
        }
      } catch (cause) {
        // No key, here or anywhere. A key is derived from a verified email and a run identifier,
        // so logging one would put an identifying value into the retention domain this demo says
        // holds none.
        this.#logger.warn('video_reaper_delete_failed', {
          errorName: cause instanceof Error ? cause.name : typeof cause,
          errorMessage: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }

    return {
      deleted,
      ...(oldestAgeMs === undefined ? {} : { oldestAgeMs }),
      budgetExhausted: expired.length >= REAP_BUDGET,
      examined: expired.length,
      elapsedMs: this.#now() - startedAt
    };
  }
}
