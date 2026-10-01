import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { DEFAULT_MAX_REQUEST_BODY_BYTES, jsonBodyLimit } from '../src/body-limit.ts';

/**
 * Build a minimal app wiring the limit in front of a trivial route, plus the same error handler a
 * demo wires, so assertions can read real HTTP status and body.
 */
function buildApp(maxBytes?: number): Hono {
  const app = new Hono();
  app.use(maxBytes === undefined ? jsonBodyLimit() : jsonBodyLimit(maxBytes));
  app.post('/', (context) => context.json({ ok: true }));
  app.onError(problemDetailsErrorHandler());
  return app;
}

describe('jsonBodyLimit', () => {
  it('defaults to an 8 KB limit', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(8_192);
  });

  it('allows a body within the limit', async () => {
    const response = await buildApp().request('/', {
      body: JSON.stringify({ destination: 'https://example.com' }),
      method: 'POST'
    });
    expect(response.status).toBe(200);
  });

  it('allows a body exactly at the limit', async () => {
    const response = await buildApp().request('/', {
      body: 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_BYTES),
      method: 'POST'
    });
    expect(response.status).toBe(200);
  });

  it('rejects an oversized body via the Content-Length fast path', async () => {
    // A string body's Content-Length is set by the Request constructor, exercising the
    // header-based check rather than the streamed fallback.
    const response = await buildApp().request('/', {
      body: 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      method: 'POST'
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({
      detail: 'Request body exceeds the 8 KB limit.'
    });
  });

  it('rejects an oversized chunked body with no Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('x'.repeat(DEFAULT_MAX_REQUEST_BODY_BYTES + 1))
        );
        controller.close();
      }
    });

    const response = await buildApp().request('/', {
      body: stream,
      method: 'POST',
      // `duplex` is required by the Fetch spec for streamed request bodies but is missing from
      // the DOM `RequestInit` type this project targets.
      // @ts-expect-error -- see above.
      duplex: 'half'
    });

    expect(response.status).toBe(400);
  });

  it('allows a request with no body at all', async () => {
    const response = await buildApp().request('/', { method: 'POST' });
    expect(response.status).toBe(200);
  });

  it('honours a caller-supplied limit', async () => {
    const response = await buildApp(16).request('/', { body: 'x'.repeat(17), method: 'POST' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      detail: 'Request body exceeds the 16 bytes limit.'
    });
  });

  it('describes a kilobyte-aligned custom limit in kilobytes', async () => {
    const response = await buildApp(2048).request('/', { body: 'x'.repeat(2049), method: 'POST' });

    expect(await response.json()).toMatchObject({
      detail: 'Request body exceeds the 2 KB limit.'
    });
  });
});
