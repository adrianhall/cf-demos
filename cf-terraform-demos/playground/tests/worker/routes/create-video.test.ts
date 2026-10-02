/**
 * @file Route tests for Create Video. Three things are specific to this panel and get the attention
 *   here: the `202` acceptance (the request succeeded, the work has not), the ranged video response
 *   that makes a `<video>` element able to seek, and the diagnostics — which must record the cost
 *   estimate a visitor was quoted while recording neither the prompt nor the verified email.
 */

import { describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type {
  CreateVideoAcceptedResponse,
  CreateVideoStatusResponse
} from '../../../src/shared/create-video';
import type { CreateVideoService } from '../../../src/worker/application/create-video/create-video-service';
import { createVideoRouter } from '../../../src/worker/routes/create-video';
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
 * Applied controls a service would echo back.
 */
const APPLIED = {
  prompt: 'A dog running',
  model: 'pixverse/v6',
  resolution: '360p',
  aspectRatio: '16:9',
  duration: 5,
  estimatedCostUsd: 0.125
};

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
 * Mounts the router with a stub service.
 *
 * @param service Partial service behaviour to simulate.
 * @param identity Verified identity to present.
 * @returns The app and the captured logs.
 */
function mount(
  service: Partial<CreateVideoService> = {},
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
  } as unknown as CreateVideoService;

  const { app } = mountRoute('/api/create-video', createVideoRouter, {
    identity,
    createVideoService: stub,
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
  return await app.request('/api/create-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

describe('POST /api/create-video', () => {
  it('answers 202, because the request succeeded but the work has not', async () => {
    const { app } = mount();

    const response = await post(app, body());

    expect(response.status).toBe(202);
    const payload = (await response.json()) as CreateVideoAcceptedResponse;
    expect(payload.state).toBe('accepted');
    expect(payload.runId).toBe(RUN_ID);
    expect(payload.applied.estimatedCostUsd).toBe(0.125);
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

    expect((await post(app, body({ jobId: 'guessed' }))).status).toBe(400);
  });

  it('rejects an oversized body before validation sees it', async () => {
    const { app } = mount();

    // There is no media going *in* to this panel, so a body shaped like an image upload is refused
    // by the transport rather than reaching the domain.
    const response = await post(app, body({ prompt: 'a'.repeat(64 * 1_024) }));

    expect(response.status).toBe(400);
  });

  describe('diagnostics', () => {
    it('logs an attempt before the job can fail', async () => {
      const { app, logs } = mount({
        async accept() {
          throw new Error('platform unavailable');
        }
      });

      await post(app, body());

      // The start line has to exist even when the job never began: that is precisely the case where
      // the parameters matter most.
      const started = logs.entries.find((entry) => entry.message === 'create_video_run_started');
      expect(started?.context?.['runId']).toBe(RUN_ID);
      expect(started?.context?.['model']).toBe('pixverse/v6');
      expect(started?.context?.['resolution']).toBe('360p');
      expect(started?.context?.['duration']).toBe(5);
    });

    it('records the quoted estimate, so it can be compared with reported cost', async () => {
      // A run whose reported cost diverges sharply from its estimate is worth noticing, and that
      // comparison is impossible if the estimate was never written down.
      const { app, logs } = mount();

      await post(app, body());

      const started = logs.entries.find((entry) => entry.message === 'create_video_run_started');
      expect(started?.context?.['estimatedCostUsd']).toBeGreaterThan(0);
    });

    it('records the prompt’s length but never its text', async () => {
      const { app, logs } = mount();

      await post(app, body({ prompt: 'a cat wearing a tiny hat' }));

      const started = logs.entries.find((entry) => entry.message === 'create_video_run_started');
      expect(started?.context?.['promptCharacters']).toBe(24);
      expect(logs.text()).not.toContain('tiny hat');
    });

    it('logs a panel-level failure correlated by run identifier', async () => {
      const { app, logs } = mount({
        async accept() {
          throw new Error('platform unavailable');
        }
      });

      await post(app, body());

      const failed = logs.entries.find((entry) => entry.message === 'create_video_run_failed');
      expect(failed?.context?.['runId']).toBe(RUN_ID);
    });

    it('never logs the verified email', async () => {
      // It belongs in AI Gateway metadata only, which is a different retention domain with
      // different access control.
      const { app, logs } = mount();

      await post(app, body());

      expect(logs.text()).not.toContain(IDENTITY.email);
    });
  });
});

describe('GET /api/create-video/:runId/status', () => {
  it('reports a job’s state', async () => {
    const { app } = mount({
      async status() {
        return { runId: RUN_ID, state: 'running' as const };
      }
    });

    const response = await app.request(`/api/create-video/${RUN_ID}/status`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as CreateVideoStatusResponse).state).toBe('running');
  });

  it('answers 404 for a job this identity cannot see', async () => {
    // The service returns `undefined` both for a job that does not exist and for one belonging to
    // someone else, deliberately: confirming its existence would itself be a disclosure.
    const { app } = mount();

    expect((await app.request(`/api/create-video/${RUN_ID}/status`)).status).toBe(404);
  });

  it('answers 404 for an implausible run identifier', async () => {
    const { app } = mount();

    expect((await app.request('/api/create-video/not-a-run/status')).status).toBe(404);
  });
});

describe('GET /api/create-video/:runId/video', () => {
  /**
   * Builds a service returning a fixed video body.
   *
   * @param total Whole-object size.
   * @param range The range the storage layer resolved.
   * @returns A partial service.
   */
  function serving(
    total: number,
    range: { offset: number; length: number }
  ): Partial<CreateVideoService> {
    return {
      async read() {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(range.length));
              controller.close();
            }
          }),
          mediaType: 'video/mp4' as const,
          byteLength: total,
          rangeOffset: range.offset,
          rangeLength: range.length
        };
      }
    };
  }

  it('serves the whole video with the sniffed content type', async () => {
    const { app } = mount(serving(1_000, { offset: 0, length: 1_000 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`);

    expect(response.status).toBe(200);
    // The type established by inspecting bytes, never the provider's declared one — this is the
    // header that decides how a browser treats content served from this demo's own origin.
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps a generated video out of shared caches', async () => {
    // It is private to one visitor and addressed by a derived key, so a shared cache must not hold
    // it.
    const { app } = mount(serving(1_000, { offset: 0, length: 1_000 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`);

    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('answers a ranged request with 206 and a content range', async () => {
    // Range support is the whole reason the video lives in storage: a `<video>` element seeks by
    // asking for byte ranges, which a base64 JSON payload cannot answer.
    const { app } = mount(serving(1_000, { offset: 200, length: 100 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`, {
      headers: { range: 'bytes=200-299' }
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 200-299/1000');
    expect(response.headers.get('content-length')).toBe('100');
  });

  it('answers an open-ended range', async () => {
    const { app } = mount(serving(1_000, { offset: 500, length: 500 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`, {
      headers: { range: 'bytes=500-' }
    });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 500-999/1000');
  });

  it.each([
    ['a malformed range', 'bytes=abc'],
    ['an inverted range', 'bytes=900-100'],
    ['a suffix range', 'bytes=-500'],
    ['a non-byte unit', 'items=0-10']
  ])('falls back to the whole video for %s', async (_label, header) => {
    // A browser treats a `200` as "ranges not supported" and copes, which is the honest answer to a
    // request this demo did not understand.
    const { app } = mount(serving(1_000, { offset: 0, length: 1_000 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`, {
      headers: { range: header }
    });

    expect(response.status).toBe(200);
  });

  it('answers 404 when there is no video for this identity', async () => {
    const { app } = mount();

    expect((await app.request(`/api/create-video/${RUN_ID}/video`)).status).toBe(404);
  });

  it('never redirects to the provider', async () => {
    // Redirecting would put the provider's host back in the visitor's browser, leaking their IP and
    // making the result depend on an external retention policy.
    const { app } = mount(serving(10, { offset: 0, length: 10 }));

    const response = await app.request(`/api/create-video/${RUN_ID}/video`);

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('POST /api/create-video/:runId/cancel', () => {
  it('reports the cancelled state', async () => {
    const { app, logs } = mount({
      async cancel() {
        return true;
      }
    });

    const response = await app.request(`/api/create-video/${RUN_ID}/cancel`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as CreateVideoStatusResponse).state).toBe('cancelled');
    expect(logs.entries.some((entry) => entry.message === 'create_video_run_cancelled')).toBe(true);
  });

  it('answers 404 when there is nothing to cancel', async () => {
    const { app } = mount();

    expect(
      (await app.request(`/api/create-video/${RUN_ID}/cancel`, { method: 'POST' })).status
    ).toBe(404);
  });
});
