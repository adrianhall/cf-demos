/**
 * @file Route tests for Animate Image. Four things get the attention here: the `202` acceptance
 *   (the request succeeded, the work has not), the ranged video response that lets a `<video>`
 *   element seek, the refusal of a caller-named image location, and the diagnostics — which must
 *   record what a run was expected to cost and the facts read from the picture's bytes, while
 *   recording neither the motion prompt, nor the picture, nor the verified email.
 */

import { describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type {
  AnimateImageAcceptedResponse,
  AnimateImageStatusResponse,
  AppliedAnimateImageControls
} from '../../../src/shared/animate-image';
import type { AnimateImageService } from '../../../src/worker/application/animate-image/animate-image-service';
import { animateImageRouter } from '../../../src/worker/routes/animate-image';
import { pngBase64 } from '../support/image-fixtures';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * The motion prompt every valid request below carries, so a log assertion has a distinctive string
 * to prove absent.
 */
const MOTION_PROMPT = 'a slow cinematic push towards the lighthouse';

/**
 * Applied controls a service would echo back.
 */
const APPLIED: AppliedAnimateImageControls = {
  model: 'alibaba/hh1.1-i2v',
  resolution: '720P',
  duration: 5,
  source: { mediaType: 'image/png', byteLength: 120, width: 64, height: 64 },
  motionPrompt: MOTION_PROMPT,
  estimatedCostUsd: 0.7,
  estimateKnown: true
};

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
    motionPrompt: MOTION_PROMPT,
    resolution: '720P',
    duration: 5,
    ...overrides
  };
}

/**
 * Mounts the router with a stub service.
 *
 * @param service Partial service behaviour to simulate.
 * @param identity Verified identity to present.
 * @returns The app and the captured logs.
 */
function mount(
  service: Partial<AnimateImageService> = {},
  identity: { email: string; sub: string } | undefined = IDENTITY
): { app: ReturnType<typeof mountRoute>['app']; logs: LogCapture } {
  const { capture, logger } = createLogCapture();

  const stub = {
    async accept() {
      return { runId: RUN_ID, state: 'accepted' as const, applied: APPLIED };
    },
    async status() {
      return undefined;
    },
    async read() {
      return undefined;
    },
    async cancel() {
      return false;
    },
    ...service
  } as unknown as AnimateImageService;

  const { app } = mountRoute('/api/animate-image', animateImageRouter, {
    identity,
    animateImageService: stub,
    logger
  });
  app.onError(problemDetailsErrorHandler({ includeStack: false }));

  return { app, logs: capture };
}

/**
 * Dispatches a JSON POST to the start endpoint.
 *
 * @param app The mounted app.
 * @param payload Request body.
 * @returns The response.
 */
async function post(
  app: ReturnType<typeof mountRoute>['app'],
  payload: unknown
): Promise<Response> {
  return await app.request('/api/animate-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

describe('POST /api/animate-image', () => {
  it('answers 202, because the request succeeded but the work has not', async () => {
    const { app } = mount();

    const response = await post(app, body());

    expect(response.status).toBe(202);
    const payload = (await response.json()) as AnimateImageAcceptedResponse;
    expect(payload.state).toBe('accepted');
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.applied.estimatedCostUsd).toBe(0.7);
    expect(payload.applied.source.width).toBe(64);
  });

  it('rejects a malformed request with problem details', async () => {
    const { app } = mount();

    const response = await post(app, body({ duration: 999 }));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects a body carrying an identity', async () => {
    const { app } = mount();

    expect((await post(app, body({ email: 'bob@example.com' }))).status).toBe(400);
  });

  it('rejects a body naming its own job', async () => {
    const { app } = mount();

    expect((await post(app, body({ instanceId: 'deadbeef' }))).status).toBe(400);
  });

  // The security boundary: the returned URL is fetched server-side and the source URI is sent to a
  // third party, so neither may be chosen by a caller.
  it('rejects a body naming the picture\u2019s location instead of its bytes', async () => {
    const { app } = mount();

    const response = await post(app, body({ image_uri: 'https://internal.test/secret.png' }));

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(/never fetches a picture/u);
  });

  it('rejects a request with no picture', async () => {
    const { app } = mount();

    expect((await post(app, body({ imageBase64: undefined }))).status).toBe(400);
  });

  it('logs the attempt with its cost estimate and the byte-derived source facts', async () => {
    const { app, logs } = mount();

    await post(app, body());

    const started = logs.entries.find((entry) => entry.message === 'animate_image_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: 'alibaba/hh1.1-i2v',
      resolution: '720P',
      duration: 5,
      estimateKnown: true,
      sourceMediaType: 'image/png'
    });
    // Compared approximately: the estimate is the product of a published rate and a duration, so
    // pinning it exactly would be asserting IEEE-754 behaviour rather than the panel's.
    expect(started?.context?.['estimatedCostUsd']).toBeCloseTo(0.7, 10);
  });

  it('logs neither the motion prompt, the picture, nor the verified email', async () => {
    // The demo's standing promise, asserted rather than assumed. The prompt's *length* is recorded
    // so an empty request is distinguishable from a real one; its content never is.
    const { app, logs } = mount();

    await post(app, body());

    const text = logs.text();
    expect(text).not.toContain(MOTION_PROMPT);
    expect(text).not.toContain(IDENTITY.email);
    expect(text).not.toContain(pngBase64());
    expect(text).toContain('motionPromptCharacters');
  });

  it('logs a failed start against the run identifier', async () => {
    const { app, logs } = mount({
      async accept() {
        throw new Error('nope');
      }
    });

    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'animate_image_run_failed')).toBe(true);
  });
});

describe('GET /api/animate-image/:runId/status', () => {
  it('reports a job to its owner', async () => {
    const { app } = mount({
      async status() {
        return { runId: RUN_ID, state: 'running' as const };
      }
    });

    const response = await app.request(`/api/animate-image/${RUN_ID}/status`);

    expect(response.status).toBe(200);
    expect((await response.json()) as AnimateImageStatusResponse).toEqual({
      runId: RUN_ID,
      state: 'running'
    });
  });

  it('forwards a failure reason so the panel can distinguish a billing failure', async () => {
    const { app } = mount({
      async status() {
        return { runId: RUN_ID, state: 'failed' as const, reason: 'insufficient-credit' as const };
      }
    });

    const payload = (await (
      await app.request(`/api/animate-image/${RUN_ID}/status`)
    ).json()) as AnimateImageStatusResponse;

    expect(payload.reason).toBe('insufficient-credit');
  });

  it('answers 404 for an unknown job', async () => {
    const { app } = mount();

    expect((await app.request(`/api/animate-image/${RUN_ID}/status`)).status).toBe(404);
  });

  it('answers 404 for an implausible run identifier without consulting the service', async () => {
    let consulted = false;
    const { app } = mount({
      async status() {
        consulted = true;
        return undefined;
      }
    });

    // Too short for the shared run-identifier rule, and carrying a character it excludes.
    expect((await app.request('/api/animate-image/no%21/status')).status).toBe(404);
    expect(consulted).toBe(false);
  });
});

describe('GET /api/animate-image/:runId/video', () => {
  /**
   * Builds a stub read result.
   *
   * @param rangeOffset First byte served.
   * @param rangeLength How many bytes served.
   * @returns A stored-video body double.
   */
  function stored(rangeOffset = 0, rangeLength = 100) {
    return {
      body: new ReadableStream(),
      mediaType: 'video/mp4' as const,
      byteLength: 100,
      rangeOffset,
      rangeLength
    };
  }

  it('serves the whole video with the sniffed media type', async () => {
    const { app } = mount({
      async read() {
        return stored();
      }
    });

    const response = await app.request(`/api/animate-image/${RUN_ID}/video`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    // A generated video is private to one visitor and served from a derived key.
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a ranged request with 206 and a content-range', async () => {
    // The reason the video is in storage at all: a `<video>` element seeks by asking for ranges,
    // which a base64 JSON body cannot answer.
    const { app } = mount({
      async read() {
        return stored(10, 20);
      }
    });

    const response = await app.request(`/api/animate-image/${RUN_ID}/video`, {
      headers: { range: 'bytes=10-29' }
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 10-29/100');
  });

  it('answers 404 when no video exists for this identity', async () => {
    const { app } = mount();

    expect((await app.request(`/api/animate-image/${RUN_ID}/video`)).status).toBe(404);
  });
});

describe('POST /api/animate-image/:runId/cancel', () => {
  it('reports the cancelled state', async () => {
    const { app } = mount({
      async cancel() {
        return true;
      }
    });

    const response = await app.request(`/api/animate-image/${RUN_ID}/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect((await response.json()) as AnimateImageStatusResponse).toEqual({
      runId: RUN_ID,
      state: 'cancelled'
    });
  });

  it('answers 404 when there was no job to cancel', async () => {
    const { app } = mount();

    expect(
      (await app.request(`/api/animate-image/${RUN_ID}/cancel`, { method: 'POST' })).status
    ).toBe(404);
  });
});
