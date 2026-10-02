import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createImage,
  fetchRunMetrics,
  streamChat
} from '../../../src/client/services/playground-api';
import type { ChatRequest, ChatStreamEvent } from '../../../src/shared/chat';
import type { CreateImageRequest } from '../../../src/shared/images';
import { formatSseFrame } from '../../../src/shared/sse';

/**
 * A valid Chat request.
 */
const REQUEST: ChatRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: '@cf/meta/llama-3.2-3b-instruct',
  runId: 'eeeeeeee-1111-4222-8333-444455556666'
};

/**
 * Stubs `fetch` with a streaming SSE response.
 *
 * @param body Raw response text to stream.
 * @param chunkSize Bytes per chunk, so a test can split frames the way a network does.
 * @returns The fetch spy.
 */
function stubStream(body: string, chunkSize?: number) {
  const bytes = new TextEncoder().encode(body);
  const size = chunkSize ?? bytes.length;

  const spy = vi.fn(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += size) {
              controller.enqueue(bytes.slice(offset, offset + size));
            }
            controller.close();
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )
  );

  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * Reads the URL and init of a fetch spy's most recent call.
 *
 * Narrowing here rather than at each assertion keeps the tests readable and keeps the unavoidable
 * `unknown[]` handling of a mock's argument tuple in one place.
 *
 * @param spy The fetch spy.
 * @returns The requested URL as a string, and the request init when one was passed.
 */
function lastCall(spy: { mock: { calls: unknown[][] } }): [string, RequestInit | undefined] {
  const call = spy.mock.calls.at(-1) ?? [];
  const [url, init] = call;
  return [String(url), init as RequestInit | undefined];
}

/**
 * Collects every event a stream yields.
 *
 * @param iterable The event stream.
 * @returns The events, in order.
 */
async function collect(iterable: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChat', () => {
  it('posts the request as JSON to the stream route', async () => {
    const spy = stubStream(formatSseFrame('delta', { type: 'delta', text: 'hi' }));
    await collect(streamChat(REQUEST));

    const [url, init] = lastCall(spy);
    expect(url).toBe('/api/chat/stream');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual(REQUEST);
  });

  it('yields the typed events in order', async () => {
    stubStream(
      formatSseFrame('start', { type: 'start', runId: 'r1', model: 'm' })
        + formatSseFrame('delta', { type: 'delta', text: 'Hel' })
        + formatSseFrame('delta', { type: 'delta', text: 'lo' })
        + formatSseFrame('completed', { type: 'completed', receipt: { runId: 'r1' } })
    );

    const events = await collect(streamChat(REQUEST));
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'completed']);
  });

  // A chunk boundary falls wherever the network puts it. Reassembly is the difference between a
  // correct answer and a silently truncated one.
  it('reassembles events split across chunk boundaries', async () => {
    stubStream(
      formatSseFrame('delta', { type: 'delta', text: 'one' })
        + formatSseFrame('delta', { type: 'delta', text: 'two' }),
      5
    );

    const events = await collect(streamChat(REQUEST));
    expect(events).toHaveLength(2);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    stubStream(
      formatSseFrame('delta', { type: 'delta', text: '\u3053\u3093\u306b\u3061\u306f' }),
      4
    );

    const events = await collect(streamChat(REQUEST));
    expect(events[0]).toEqual({ type: 'delta', text: '\u3053\u3093\u306b\u3061\u306f' });
  });

  // A keep-alive or a newer server event must not destroy an answer the visitor is already reading.
  it('skips an unrecognised event type', async () => {
    stubStream(
      formatSseFrame('delta', { type: 'delta', text: 'kept' })
        + formatSseFrame('future', { type: 'something-new' })
    );

    const events = await collect(streamChat(REQUEST));
    expect(events).toEqual([{ type: 'delta', text: 'kept' }]);
  });

  it('skips a frame carrying invalid JSON', async () => {
    stubStream(
      'event: delta\ndata: not json\n\n' + formatSseFrame('delta', { type: 'delta', text: 'ok' })
    );

    const events = await collect(streamChat(REQUEST));
    expect(events).toEqual([{ type: 'delta', text: 'ok' }]);
  });

  it('throws an ApiError carrying the problem detail when the request is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 400, detail: 'Send at least one message.' }), {
            status: 400,
            headers: { 'content-type': 'application/problem+json' }
          })
        )
      )
    );

    await expect(collect(streamChat(REQUEST))).rejects.toThrow('Send at least one message.');
  });

  it('reports the status on the thrown ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 401, detail: 'Session expired.' }), {
            status: 401
          })
        )
      )
    );

    const error = await collect(streamChat(REQUEST)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it('falls back to a status message when the failure is not a problem document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>Gateway timeout</html>', { status: 504 })))
    );

    await expect(collect(streamChat(REQUEST))).rejects.toThrow(/504/u);
  });

  it('forwards an abort signal to fetch', async () => {
    const spy = stubStream(formatSseFrame('delta', { type: 'delta', text: 'hi' }));
    const controller = new AbortController();

    await collect(streamChat(REQUEST, controller.signal));
    expect(lastCall(spy)[1]?.signal).toBe(controller.signal);
  });
});

describe('fetchRunMetrics', () => {
  it('requests the metrics endpoint for the run', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runId: 'run-1', costStatus: 'pending', requests: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );
    vi.stubGlobal('fetch', spy);

    const metrics = await fetchRunMetrics('run-1');
    expect(lastCall(spy)[0]).toBe('/api/runs/run-1/metrics');
    expect(metrics.costStatus).toBe('pending');
  });

  // The identifier goes into a URL path, so it is encoded rather than interpolated raw.
  it('encodes the run identifier', async () => {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runId: 'x', costStatus: 'pending', requests: [] }), {
          status: 200
        })
      )
    );
    vi.stubGlobal('fetch', spy);

    await fetchRunMetrics('a/b');
    expect(lastCall(spy)[0]).toBe('/api/runs/a%2Fb/metrics');
  });

  it('throws an ApiError with the status when the run is denied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 403, detail: 'Not yours.' }), { status: 403 })
        )
      )
    );

    const error = await fetchRunMetrics('run-1').catch((cause: unknown) => cause);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).message).toBe('Not yours.');
  });
});

describe('createImage', () => {
  /**
   * A valid image request.
   */
  const IMAGE_REQUEST: CreateImageRequest = {
    prompt: 'a lighthouse',
    model: '@cf/black-forest-labs/flux-1-schnell',
    runId: 'f00dbabe-1111-4222-8333-444455556666'
  };

  /**
   * A successful response body.
   */
  const RESULT = {
    image: { base64: 'AAAA', mediaType: 'image/png', byteLength: 1_024 },
    receipt: {
      runId: IMAGE_REQUEST.runId,
      task: 'create-image',
      model: IMAGE_REQUEST.model,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 4_200,
      startedAt: '2026-04-01T09:15:00.000Z'
    },
    applied: { prompt: 'a lighthouse', model: IMAGE_REQUEST.model, steps: 4 }
  };

  /**
   * Stubs `fetch` with a JSON response.
   *
   * @param payload Body to return.
   * @param status HTTP status to return.
   * @returns The fetch spy.
   */
  function stubJson(payload: unknown, status = 200) {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      )
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('posts the request as JSON to the image route', async () => {
    const spy = stubJson(RESULT);
    await createImage(IMAGE_REQUEST);

    const [url, init] = lastCall(spy);
    expect(url).toBe('/api/create-image');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual(IMAGE_REQUEST);
  });

  it('returns the image, receipt, and applied controls', async () => {
    stubJson(RESULT);
    const result = await createImage(IMAGE_REQUEST);

    expect(result.image.mediaType).toBe('image/png');
    expect(result.receipt.task).toBe('create-image');
    expect(result.applied.steps).toBe(4);
  });

  // The server's own explanation is the one written for a visitor — particularly here, where it
  // names the control and the model that does not support it.
  it('throws an ApiError carrying the problem detail', async () => {
    stubJson({ status: 400, detail: 'FLUX.1 [schnell] does not support "seed".' }, 400);

    await expect(createImage(IMAGE_REQUEST)).rejects.toThrow(/does not support "seed"/u);
  });

  it('reports the status on the thrown ApiError', async () => {
    stubJson({ status: 502, detail: 'The image could not be generated.' }, 502);

    const error = await createImage(IMAGE_REQUEST).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('falls back to a status message when the failure is not a problem document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>Gateway timeout</html>', { status: 504 })))
    );

    await expect(createImage(IMAGE_REQUEST)).rejects.toThrow(/504/u);
  });

  it('forwards an abort signal to fetch', async () => {
    const spy = stubJson(RESULT);
    const controller = new AbortController();

    await createImage(IMAGE_REQUEST, controller.signal);
    expect(lastCall(spy)[1]?.signal).toBe(controller.signal);
  });
});
