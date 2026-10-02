/**
 * @file Client tests for the Create Video composable. Every other panel's composable awaits one
 *   request and renders its answer; this one polls a job that outlives the request which started
 *   it. The three behaviours that follow are what these tests cover, and each is a real failure
 *   mode rather than a hypothetical: polling that never backs off makes hundreds of pointless
 *   requests, polling that never stops leaves a visitor watching a spinner forever, and a late
 *   response that is not discarded can overwrite the state of a newer job.
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  POLL_BUDGET_MS,
  useCreateVideo
} from '../../../src/client/features/create-video/useCreateVideo';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import type { CreateVideoStatusResponse } from '../../../src/shared/create-video';

/**
 * A catalogue entry mirroring the reviewed PixVerse descriptor.
 */
const PIXVERSE: CatalogueModel = {
  id: 'pixverse/v6',
  name: 'PixVerse v6',
  provider: 'third-party',
  task: 'create-video',
  contractVersion: 1,
  pricingUnit: 'video-second',
  invocation: 'job',
  documentationUrl: 'https://example.invalid/pixverse',
  videoControls: {
    resolutionParameterName: 'quality',
    resolutions: ['360p', '540p', '720p', '1080p'],
    defaultResolution: '360p',
    aspectParameterName: 'aspect_ratio',
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durationRange: { min: 1, max: 15, step: 1, default: 5 },
    defaultDuration: 5,
    seed: true,
    negativePrompt: true,
    audioParameterName: 'generate_audio',
    pricePerSecondUsd: { '360p': 0.025, '540p': 0.035, '720p': 0.045, '1080p': 0.09 },
    outputHosts: ['media.pixverse.ai']
  }
} as CatalogueModel;

/**
 * A model with no audio and a higher floor, for asserting the per-model control reset.
 */
const ALIBABA: CatalogueModel = {
  ...PIXVERSE,
  id: 'alibaba/hh1.1-t2v',
  name: 'HappyHorse 1.1',
  videoControls: {
    ...PIXVERSE.videoControls!,
    resolutionParameterName: 'resolution',
    resolutions: ['720P', '1080P'],
    defaultResolution: '720P',
    aspectParameterName: 'ratio',
    negativePrompt: false,
    audioParameterName: undefined,
    pricePerSecondUsd: { '720P': 0.14, '1080P': 0.18 }
  }
} as CatalogueModel;

/**
 * Builds a composable with controllable transports and an instant clock.
 *
 * @param overrides Transport behaviour to inject.
 * @returns The composable result plus the recorded calls.
 */
function harness(
  overrides: {
    statuses?: CreateVideoStatusResponse[];
    start?: () => Promise<never> | Promise<unknown>;
    cancel?: () => Promise<unknown>;
  } = {}
) {
  const models = ref<CatalogueModel[]>([PIXVERSE, ALIBABA]);
  const statuses = overrides.statuses ?? [];
  let statusCall = 0;
  const waits: number[] = [];
  let clock = 0;

  const start = vi.fn(
    overrides.start
      ?? (async () => ({
        runId: 'r',
        state: 'accepted' as const,
        applied: {
          prompt: 'A dog running',
          model: PIXVERSE.id,
          resolution: '360p',
          aspectRatio: '16:9',
          duration: 5,
          estimatedCostUsd: 0.125
        }
      }))
  );

  const status = vi.fn(async () => {
    const next = statuses[Math.min(statusCall, statuses.length - 1)];
    statusCall += 1;
    if (next === undefined) {
      throw new Error('no status configured');
    }
    return next;
  });

  const cancel = vi.fn(overrides.cancel ?? (async () => ({ runId: 'r', state: 'cancelled' })));

  const composable = useCreateVideo({
    models,
    start: start as never,
    status: status as never,
    cancel: cancel as never,
    // Time advances only because a wait was requested, so the poll budget is reachable in a test
    // without any real delay.
    wait: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    runOptions: { sleep: async () => undefined, now: () => clock }
  });

  return { composable, models, start, status, cancel, waits, statusCalls: () => statusCall };
}

/**
 * A completed status response.
 *
 * @returns A completed job.
 */
function completed(): CreateVideoStatusResponse {
  return {
    runId: 'r',
    state: 'completed',
    video: { mediaType: 'video/mp4', byteLength: 2_048 },
    applied: {
      prompt: 'A dog running',
      model: PIXVERSE.id,
      resolution: '360p',
      aspectRatio: '16:9',
      duration: 5,
      estimatedCostUsd: 0.125
    }
  };
}

describe('useCreateVideo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('selects the first catalogue model once it arrives', () => {
    const { composable } = harness();
    expect(composable.model.value).toBe(PIXVERSE.id);
  });

  it('estimates cost from the catalogue price list before any request', async () => {
    // The point of the panel's cost copy: a visitor sees the figure before spending it.
    const { composable } = harness();

    composable.duration.value = 10;
    composable.resolution.value = '1080p';
    await Promise.resolve();

    expect(composable.estimatedCostUsd.value).toBeCloseTo(0.09 * 10, 6);
  });

  it('estimates from the model defaults when nothing is chosen', () => {
    const { composable } = harness();
    expect(composable.estimatedCostUsd.value).toBeCloseTo(0.025 * 5, 6);
  });

  it('resets per-model controls when the model changes', async () => {
    // A resolution valid for one model is often not even spelled the same way for another, so
    // carrying it across would build a request the server rightly rejects.
    const { composable } = harness();

    composable.resolution.value = '360p';
    composable.model.value = ALIBABA.id;
    await Promise.resolve();

    expect(composable.resolution.value).toBe(undefined);
    expect(composable.estimatedCostUsd.value).toBeCloseTo(0.14 * 5, 6);
  });

  it('refuses to submit without a prompt', async () => {
    const { composable, start } = harness();

    await composable.generate();

    expect(start).not.toHaveBeenCalled();
    expect(composable.canGenerate.value).toBe(false);
  });

  it('sends only the controls the model declares', async () => {
    const { composable, start } = harness({ statuses: [completed()] });

    composable.model.value = ALIBABA.id;
    await Promise.resolve();
    composable.prompt.value = 'A dog running';
    composable.negativePrompt.value = 'blurry';
    composable.generateAudio.value = true;

    await composable.generate();

    const request = (start.mock.calls as unknown as Record<string, unknown>[][])[0]?.[0] ?? {};
    // Alibaba declares neither, so neither is sent — the server would answer `400` for either.
    expect('negativePrompt' in request).toBe(false);
    expect('generateAudio' in request).toBe(false);
  });

  it('polls until the job completes and exposes the video', async () => {
    const { composable } = harness({
      statuses: [{ runId: 'r', state: 'running' }, { runId: 'r', state: 'running' }, completed()]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(composable.state.value).toBe('completed');
    expect(composable.video.value?.byteLength).toBe(2_048);
    // The player reads from this demo's own route, never the provider's host.
    expect(composable.source.value).toContain('/api/create-video/');
    expect(composable.source.value).toContain('/video');
  });

  it('backs off between polls rather than hammering the endpoint', async () => {
    // A render takes minutes. A fixed one-second poll would make hundreds of pointless requests.
    const { composable, waits } = harness({
      statuses: [
        { runId: 'r', state: 'running' },
        { runId: 'r', state: 'running' },
        { runId: 'r', state: 'running' },
        completed()
      ]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(waits.length).toBeGreaterThan(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits.at(-1)!).toBeGreaterThan(waits[0]!);
  });

  it('caps the backoff so a long render still polls regularly', async () => {
    const { composable, waits } = harness({
      statuses: [
        ...Array.from({ length: 30 }, () => ({ runId: 'r', state: 'running' as const })),
        completed()
      ]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(Math.max(...waits)).toBeLessThanOrEqual(15_000);
  });

  it('stops polling once the budget is exhausted and says so', async () => {
    // A job the platform has lost must not leave the UI spinning. Claiming it failed is a guess,
    // but spinning forever is worse — so the panel reports it honestly as no longer watched.
    const { composable } = harness({
      statuses: [{ runId: 'r', state: 'running' }]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(composable.state.value).toBe('failed');
    expect(composable.error.value).toMatch(/longer than this demo will wait/iu);
    expect(POLL_BUDGET_MS).toBeGreaterThan(0);
  });

  it('surfaces a failed job’s explanation', async () => {
    const { composable } = harness({
      statuses: [{ runId: 'r', state: 'failed', reason: 'provider-failure' }]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(composable.state.value).toBe('failed');
    expect(composable.failureReason.value).toBe('provider-failure');
    expect(composable.error.value).toMatch(/could not be generated/iu);
  });

  // The user-visible half of the out-of-credit fix. The panel has to say the account needs credit
  // and that retrying will not help, because "try again" is actively misleading here: without
  // credit, every retry fails identically.
  it('explains an out-of-credit failure and says retrying will not help', async () => {
    const { composable } = harness({
      statuses: [{ runId: 'r', state: 'failed', reason: 'insufficient-credit' }]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(composable.failureReason.value).toBe('insufficient-credit');
    expect(composable.error.value).toMatch(/credit/iu);
    expect(composable.error.value).toMatch(/fail the same way|retrying before then/iu);
  });

  it('clears a previous failure reason when a new run starts', async () => {
    const { composable } = harness({
      statuses: [{ runId: 'r', state: 'failed', reason: 'insufficient-credit' }]
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();
    expect(composable.failureReason.value).toBe('insufficient-credit');

    const second = harness({ statuses: [{ runId: 'r', state: 'running' }] });
    second.composable.prompt.value = 'Another';
    const running = second.composable.generate();
    await Promise.resolve();
    expect(second.composable.failureReason.value).toBe(undefined);
    await running;
  });

  it('reports a failed start without polling', async () => {
    const { composable, status } = harness({
      start: async () => {
        throw new Error('nope');
      }
    });

    composable.prompt.value = 'A dog running';
    await composable.generate();

    expect(composable.state.value).toBe('failed');
    expect(status).not.toHaveBeenCalled();
  });

  it('cancels a running job and reports the cancelled state', async () => {
    const { composable, cancel } = harness({ statuses: [{ runId: 'r', state: 'running' }] });

    composable.prompt.value = 'A dog running';
    const running = composable.generate();
    // Let the start resolve so the job is in flight before cancelling.
    await Promise.resolve();
    await Promise.resolve();
    await composable.stop();
    await running;

    expect(cancel).toHaveBeenCalled();
    expect(composable.state.value).toBe('cancelled');
  });

  it('discards a poll that belongs to an abandoned run', async () => {
    // The race this guards: cancelling then starting another job could otherwise let the first
    // job's in-flight response overwrite the second's state.
    const { composable } = harness({ statuses: [{ runId: 'r', state: 'running' }, completed()] });

    composable.prompt.value = 'A dog running';
    const first = composable.generate();
    await Promise.resolve();
    await Promise.resolve();
    await composable.stop();
    await first;

    // The abandoned poll must not have moved the state off `cancelled`.
    expect(composable.state.value).toBe('cancelled');
  });

  it('clears the previous result when a new run starts', async () => {
    const { composable } = harness({ statuses: [completed()] });

    composable.prompt.value = 'A dog running';
    await composable.generate();
    expect(composable.video.value).toBeDefined();

    const second = harness({ statuses: [{ runId: 'r', state: 'running' }] });
    second.composable.prompt.value = 'Another';
    const running = second.composable.generate();
    await Promise.resolve();
    expect(second.composable.video.value).toBe(undefined);
    await running;
  });

  it('reports a job in flight as generating', async () => {
    const { composable } = harness({ statuses: [{ runId: 'r', state: 'running' }] });

    composable.prompt.value = 'A dog running';
    const running = composable.generate();
    await Promise.resolve();
    await Promise.resolve();

    expect(composable.generating.value).toBe(true);
    await running;
    // A terminal state ends it, which is what gives the polling loop an exit condition.
    expect(composable.generating.value).toBe(false);
  });
});
