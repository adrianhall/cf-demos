/**
 * @file Client tests for the Animate Image composable. It inherits Create Video's polling
 *   discipline, so the job-lifecycle behaviours are covered here too — backing off, stopping, and
 *   discarding a late response are all real failure modes rather than hypothetical ones. Three
 *   behaviours are this panel's own and get the closest attention. **A picture is required and
 *   survives a failed run**, because losing an upload to a billing failure would be a second
 *   punishment for an account problem. **The per-model controls reset**, because the two models
 *   share no resolution value and disagree about which durations exist. And **an estimate can be
 *   genuinely unknown**, which must stay distinguishable from free.
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  animateFailureMessage,
  ANIMATE_POLL_BUDGET_MS,
  useAnimateImage
} from '../../../src/client/features/animate-image/useAnimateImage';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import type {
  AnimateImageStatusResponse,
  AppliedAnimateImageControls
} from '../../../src/shared/animate-image';

/**
 * A catalogue entry mirroring the reviewed Alibaba descriptor: a duration range, an optional
 * prompt, and a per-second price.
 */
const ALIBABA: CatalogueModel = {
  id: 'alibaba/hh1.1-i2v',
  name: 'HappyHorse 1.1 I2V',
  provider: 'third-party',
  task: 'animate-image',
  contractVersion: 1,
  pricingUnit: 'video-second',
  invocation: 'job',
  documentationUrl: 'https://example.invalid/hh11i2v',
  animateImageControls: {
    imageParameterName: 'image',
    imageDelivery: 'data-uri',
    motionPromptRequired: false,
    resolutions: ['720P', '1080P'],
    defaultResolution: '720P',
    durationRange: { min: 3, max: 15, step: 1, default: 5 },
    defaultDuration: 5,
    seed: true,
    negativePrompt: true,
    pricePerSecondUsd: { '720P': 0.14, '1080P': 0.18 },
    outputHosts: ['examples.aig.cloudflare.com']
  }
} as CatalogueModel;

/**
 * A catalogue entry mirroring the reviewed MiniMax descriptor: fixed durations, a required prompt,
 * and prices published per exact combination — including one combination with no price.
 */
const MINIMAX: CatalogueModel = {
  id: 'minimax/hailuo-2.3',
  name: 'MiniMax Hailuo 2.3',
  provider: 'third-party',
  task: 'animate-image',
  contractVersion: 1,
  pricingUnit: 'video-second',
  invocation: 'job',
  documentationUrl: 'https://example.invalid/hailuo',
  animateImageControls: {
    imageParameterName: 'first_frame_image',
    imageDelivery: 'data-uri',
    motionPromptRequired: true,
    resolutions: ['768P', '1080P'],
    defaultResolution: '768P',
    durationChoices: [6, 10],
    defaultDuration: 6,
    seed: false,
    negativePrompt: false,
    priceByCombinationUsd: { '768P@6': 0.28, '768P@10': 0.56, '1080P@6': 0.49 },
    outputHosts: ['video-product.cdn.minimax.io']
  }
} as CatalogueModel;

/**
 * A prepared picture, as the shared picker would produce it.
 */
const PICTURE = {
  base64: 'aGVsbG8=',
  previewUri: 'data:image/png;base64,aGVsbG8=',
  byteLength: 5,
  fileName: 'cliff.png'
};

/**
 * Applied controls a server would echo back.
 */
const APPLIED: AppliedAnimateImageControls = {
  model: ALIBABA.id,
  resolution: '720P',
  duration: 5,
  source: { mediaType: 'image/png', byteLength: 5, width: 64, height: 64 },
  estimatedCostUsd: 0.7,
  estimateKnown: true
};

/**
 * Builds a composable with controllable transports and an instant clock.
 *
 * @param overrides Transport behaviour to inject.
 * @returns The composable result plus the recorded calls.
 */
function harness(
  overrides: {
    statuses?: AnimateImageStatusResponse[];
    start?: () => Promise<unknown>;
    cancel?: () => Promise<unknown>;
  } = {}
) {
  const models = ref<CatalogueModel[]>([ALIBABA, MINIMAX]);
  const statuses = overrides.statuses ?? [];
  let statusCall = 0;
  const waits: number[] = [];
  let clock = 0;

  const start = vi.fn(
    overrides.start ?? (async () => ({ runId: 'r', state: 'accepted' as const, applied: APPLIED }))
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

  const composable = useAnimateImage({
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
function completed(): AnimateImageStatusResponse {
  return {
    runId: 'r',
    state: 'completed',
    video: { mediaType: 'video/mp4', byteLength: 2_048 },
    applied: APPLIED
  };
}

describe('useAnimateImage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('selects the first catalogue model once it arrives', () => {
    expect(harness().composable.model.value).toBe(ALIBABA.id);
  });

  it('refuses to submit without a picture', async () => {
    const { composable, start } = harness();

    composable.motionPrompt.value = 'a slow push in';
    await composable.animate();

    expect(start).not.toHaveBeenCalled();
    expect(composable.canAnimate.value).toBe(false);
  });

  it('allows a run with a picture and no prompt when the model permits it', () => {
    const { composable } = harness();

    composable.acceptHandoff({
      base64: PICTURE.base64,
      mediaType: 'image/png',
      byteLength: PICTURE.byteLength,
      origin: 'Generated in Create Image'
    });

    expect(composable.canAnimate.value).toBe(true);
  });

  it('requires a motion prompt for the model whose schema demands one', async () => {
    const { composable, start } = harness();

    composable.acceptHandoff({
      base64: PICTURE.base64,
      mediaType: 'image/png',
      byteLength: PICTURE.byteLength,
      origin: 'Generated in Create Image'
    });
    composable.model.value = MINIMAX.id;
    await Promise.resolve();

    expect(composable.canAnimate.value).toBe(false);

    composable.motionPrompt.value = 'drift';
    await Promise.resolve();

    expect(composable.canAnimate.value).toBe(true);

    await composable.animate();
    expect(start).toHaveBeenCalled();
  });
});

describe('cost estimation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('estimates from the per-second rate before any request', () => {
    // The point of the panel's cost copy: a visitor sees the figure before spending it.
    expect(harness().composable.estimate.value).toEqual({ costUsd: 0.14 * 5, known: true });
  });

  it('follows the duration for a per-second model', async () => {
    const { composable } = harness();

    composable.duration.value = 10;
    composable.resolution.value = '1080P';
    await Promise.resolve();

    expect(composable.estimate.value?.costUsd).toBeCloseTo(0.18 * 10, 6);
  });

  it('reads the exact published figure for a per-combination model', async () => {
    const { composable } = harness();

    composable.model.value = MINIMAX.id;
    await Promise.resolve();
    composable.duration.value = 10;
    await Promise.resolve();

    expect(composable.estimate.value).toEqual({ costUsd: 0.56, known: true });
  });

  // The assertion the `known` flag exists for. Interpolating from 0.28 at six seconds and 0.56 at
  // ten would be the browser inventing a price and attributing it to the provider.
  it('reports an unpublished combination as unknown rather than as free', async () => {
    const { composable } = harness();

    composable.model.value = MINIMAX.id;
    await Promise.resolve();
    composable.resolution.value = '1080P';
    composable.duration.value = 10;
    await Promise.resolve();

    expect(composable.estimate.value).toEqual({ costUsd: 0, known: false });
  });

  it('resets per-model controls when the model changes', async () => {
    // The two models share no resolution value and disagree about which durations exist, so
    // carrying a selection across would build a request the server rightly rejects.
    const { composable } = harness();

    composable.resolution.value = '1080P';
    composable.duration.value = 15;
    composable.model.value = MINIMAX.id;
    await Promise.resolve();

    expect(composable.resolution.value).toBeUndefined();
    expect(composable.duration.value).toBeUndefined();
    expect(composable.estimate.value).toEqual({ costUsd: 0.28, known: true });
  });
});

describe('the job lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  /**
   * Builds a harness with a picture already selected.
   *
   * @param overrides Transport behaviour to inject.
   * @returns The harness, ready to submit.
   */
  function ready(overrides: Parameters<typeof harness>[0] = {}) {
    const built = harness(overrides);
    built.composable.acceptHandoff({
      base64: PICTURE.base64,
      mediaType: 'image/png',
      byteLength: PICTURE.byteLength,
      origin: 'Generated in Create Image'
    });
    built.composable.motionPrompt.value = 'a slow push in';
    return built;
  }

  it('sends the picture and only the controls the visitor set', async () => {
    const { composable, start } = ready();

    await composable.animate();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        imageBase64: PICTURE.base64,
        model: ALIBABA.id,
        motionPrompt: 'a slow push in'
      })
    );
    // An unset control is absent rather than sent as a default the server would fill in anyway.
    // Asserted through the matcher rather than by indexing the recorded call, because the
    // injected transport is typed as taking no arguments.
    expect(start).not.toHaveBeenCalledWith(
      expect.objectContaining({ resolution: expect.anything() })
    );
    expect(start).not.toHaveBeenCalledWith(
      expect.objectContaining({ duration: expect.anything() })
    );
  });

  it('polls until the job completes and exposes the stored video', async () => {
    const { composable } = ready({ statuses: [{ runId: 'r', state: 'running' }, completed()] });

    await composable.animate();

    expect(composable.state.value).toBe('completed');
    expect(composable.video.value?.byteLength).toBe(2_048);
    expect(composable.videoSource.value).toContain('/api/animate-image/');
    // Served from this demo's own route rather than the provider's, which is what lets the player
    // seek and keeps the provider's host out of the page.
    expect(composable.videoSource.value).not.toContain('minimax');
  });

  it('backs the polling interval off rather than asking every second', async () => {
    const { composable, waits } = ready({
      statuses: [
        { runId: 'r', state: 'running' },
        { runId: 'r', state: 'running' },
        { runId: 'r', state: 'running' },
        completed()
      ]
    });

    await composable.animate();

    expect(waits.length).toBeGreaterThan(1);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  });

  it('stops polling once the budget is exhausted and says so', async () => {
    // A job the platform has lost must not leave a visitor watching a spinner forever. Claiming
    // it failed would be a guess, so the message says only what is known.
    const { composable } = ready({ statuses: [{ runId: 'r', state: 'running' }] });

    await composable.animate();

    expect(composable.state.value).toBe('failed');
    expect(composable.error.value).toMatch(/longer than this demo will wait/u);
    expect(ANIMATE_POLL_BUDGET_MS).toBeGreaterThan(0);
  });

  it('keeps the picture after a failed run', async () => {
    // Losing the upload to a billing failure would punish a visitor twice for an account problem,
    // and the still is half of the result the panel exists to show.
    const { composable } = ready({
      statuses: [{ runId: 'r', state: 'failed', reason: 'insufficient-credit' }]
    });

    await composable.animate();

    expect(composable.state.value).toBe('failed');
    expect(composable.source.value?.base64).toBe(PICTURE.base64);
  });

  it('classifies an insufficient-credit failure separately from a provider one', async () => {
    const { composable } = ready({
      statuses: [{ runId: 'r', state: 'failed', reason: 'insufficient-credit' }]
    });

    await composable.animate();

    expect(composable.failureReason.value).toBe('insufficient-credit');
    // The panel renders this as a distinct notice, because the verb is "top up", not "try again".
    expect(composable.error.value).toMatch(/no prepaid AI Gateway credit/u);
  });

  it('reports a provider failure as retryable', async () => {
    const { composable } = ready({
      statuses: [{ runId: 'r', state: 'failed', reason: 'provider-failure' }]
    });

    await composable.animate();

    expect(composable.failureReason.value).toBe('provider-failure');
    expect(composable.error.value).not.toMatch(/prepaid/u);
  });

  it('surfaces a failure to start the job', async () => {
    const { composable } = ready({
      start: async () => {
        throw new Error('network down');
      }
    });

    await composable.animate();

    expect(composable.state.value).toBe('failed');
    expect(composable.error.value).toBeTruthy();
  });

  it('cancels a job in flight', async () => {
    const { composable, cancel } = ready({ statuses: [{ runId: 'r', state: 'running' }] });

    const running = composable.animate();
    await Promise.resolve();
    await composable.stop();
    await running;

    expect(cancel).toHaveBeenCalled();
    expect(composable.state.value).toBe('cancelled');
  });

  it('discards a poll that belongs to a cancelled run', async () => {
    // Cancellation and a slow in-flight status response race each other; without the guard, the
    // old job's response would overwrite the state the visitor has already moved past.
    const { composable } = ready({ statuses: [{ runId: 'r', state: 'running' }, completed()] });

    const running = composable.animate();
    await Promise.resolve();
    await composable.stop();
    await running;

    expect(composable.state.value).toBe('cancelled');
    expect(composable.video.value).toBeUndefined();
  });

  it('clears the previous result when a new picture is chosen', async () => {
    // The layout is a comparison between one still and the video made from it, so showing an old
    // video beside a new still would claim a relationship that does not exist.
    const { composable } = ready({ statuses: [completed()] });

    await composable.animate();
    expect(composable.video.value).toBeDefined();

    composable.acceptHandoff({
      base64: 'b3RoZXI=',
      mediaType: 'image/png',
      byteLength: 5,
      origin: 'Generated in Create Image'
    });
    composable.clearSource();

    expect(composable.source.value).toBeUndefined();
    expect(composable.video.value).toBeUndefined();
  });
});

describe('the Create Image handoff', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('adopts a picture handed over from another panel', () => {
    const { composable } = harness();

    composable.acceptHandoff({
      base64: PICTURE.base64,
      mediaType: 'image/png',
      byteLength: PICTURE.byteLength,
      origin: 'Generated in Create Image'
    });

    expect(composable.source.value?.base64).toBe(PICTURE.base64);
    // The provenance is shown rather than a file name, because there is no file: the bytes never
    // touched disk.
    expect(composable.source.value?.fileName).toBe('Generated in Create Image');
    expect(composable.error.value).toBeNull();
  });

  it('refuses a handed-over picture in a type this panel cannot display', () => {
    const { composable } = harness();

    composable.acceptHandoff({
      base64: PICTURE.base64,
      // Narrowed at the type level too, but re-checked at the point of use because the value ends
      // up in a `data:` URI and that decides how the browser treats the payload.
      mediaType: 'image/svg+xml' as never,
      byteLength: PICTURE.byteLength,
      origin: 'Generated in Create Image'
    });

    expect(composable.source.value).toBeUndefined();
    expect(composable.error.value).toMatch(/not in a format this panel can display/u);
  });
});

describe('animateFailureMessage', () => {
  it('tells a visitor to add credit rather than to retry', () => {
    const message = animateFailureMessage('insufficient-credit');

    expect(message).toMatch(/Add credit/u);
    expect(message).toMatch(/retrying before then will fail the same way/iu);
    // States the catalogue fact behind the failure, so it reads as a known limitation rather than
    // as this demo being broken.
    expect(message).toMatch(/no Cloudflare-hosted model for this task/u);
  });

  it('invites another attempt for a provider failure', () => {
    expect(animateFailureMessage('provider-failure')).not.toMatch(/Add credit/u);
  });
});
