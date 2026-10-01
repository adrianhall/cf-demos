import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type { ChatStreamEvent } from '../../../src/chat';
import { parseSseBuffer } from '../../../src/sse';
import { ChatService } from '../../../src/worker/application/chat/chat-service';
import { MODEL_DESCRIPTORS } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { chatRouter, CHAT_BODY_LIMIT_BYTES } from '../../../src/worker/routes/chat';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { mountRoute, type LogCapture } from '../support/mount';

/**
 * A reviewed Chat model identifier.
 */
const MODEL = MODEL_DESCRIPTORS.find((model) => model.task === 'chat')!.id;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'cccccccc-1111-4222-8333-444455556666';

/**
 * Mounts the Chat router with a fake inference port.
 *
 * @param options Inference behaviour to simulate.
 * @param identity Verified identity to present, or `undefined` to omit it.
 * @returns The app, the fake inference port, and the captured logs.
 */
function mountChat(
  options: FakeInferenceOptions = { chunks: ['Hello'] },
  identity: { email: string; sub: string } | undefined = {
    email: 'alice@example.com',
    sub: 'sub-alice'
  }
) {
  const inference = new FakeInference(options);
  const chatService = new ChatService({ inference, runs: createMemoryRunRepository() });
  const { app, logs } = mountRoute('/api/chat', chatRouter, { identity, chatService });
  app.onError(problemDetailsErrorHandler({ includeStack: false }));
  return { app, inference, logs };
}

/**
 * Posts a Chat request and collects the stream's typed events.
 *
 * @param app The mounted app.
 * @param body Request body to send.
 * @returns The response and the parsed events, in order.
 */
async function postChat(
  app: ReturnType<typeof mountChat>['app'],
  payload: Record<string, unknown>
): Promise<{ response: Response; events: ChatStreamEvent[] }> {
  const response = await app.request('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return { response, events: [] };
  }

  const text = await response.text();
  const events = parseSseBuffer(text).frames.map(
    (frame) => JSON.parse(frame.data) as ChatStreamEvent
  );
  return { response, events };
}

/**
 * A valid request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: MODEL,
    runId: RUN_ID,
    ...overrides
  };
}

beforeEach(() => {
  clearRunRecords();
});

describe('POST /api/chat/stream', () => {
  it('answers with an event stream', async () => {
    const { app } = mountChat();
    const { response } = await postChat(app, body());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });

  // The order is the contract the browser relies on: `start`, then deltas, then exactly one
  // terminal event. A client that saw `completed` before the deltas would render an empty answer.
  it('emits start, then deltas, then completed', async () => {
    const { app } = mountChat({ chunks: ['Hel', 'lo'] });
    const { events } = await postChat(app, body());

    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'completed']);
  });

  it('names the resolved model in the start event', async () => {
    const { app } = mountChat();
    const { events } = await postChat(app, body());
    const start = events[0];
    expect(start).toMatchObject({ type: 'start', runId: RUN_ID, model: MODEL });
  });

  it('streams the generated text as delta increments', async () => {
    const { app } = mountChat({ chunks: ['The ', 'answer'] });
    const { events } = await postChat(app, body());

    const text = events
      .filter(
        (event): event is Extract<ChatStreamEvent, { type: 'delta' }> => event.type === 'delta'
      )
      .map((event) => event.text)
      .join('');
    expect(text).toBe('The answer');
  });

  it('carries the run receipt in the completed event', async () => {
    const { app } = mountChat({ chunks: ['hi'], logId: 'log-9' });
    const { events } = await postChat(app, body());

    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'completed',
      receipt: {
        runId: RUN_ID,
        task: 'chat',
        gatewayRouted: true,
        status: 'completed',
        costStatus: 'pending',
        logIds: ['log-9']
      }
    });
  });

  // The identity reaches the gateway only from the verified JWT. There is no code path by which a
  // body or header value could become the actor, which is why the domain rejects a body carrying
  // one rather than filtering it.
  it('attributes the gateway metadata to the verified identity', async () => {
    const { app, inference } = mountChat();
    await postChat(app, body());
    expect(inference.requests[0]?.actor.email).toBe('alice@example.com');
  });

  it('refuses a request whose body tries to supply the user', async () => {
    const { app, inference } = mountChat();
    const { response } = await postChat(app, body({ user: 'attacker@example.com' }));

    expect(response.status).toBe(400);
    // Refused before dispatch, so no unattributable request reached a provider.
    expect(inference.requests).toEqual([]);
  });

  it('refuses a request whose body tries to supply a system prompt', async () => {
    const { app } = mountChat();
    const { response } = await postChat(app, body({ system: 'You are a pirate' }));
    expect(response.status).toBe(400);
  });

  // A second identity asking the identical question must produce different attribution, or the
  // whole per-user cost story is decorative.
  it('attributes a second identity\u2019s identical prompt to that identity', async () => {
    const { app, inference } = mountChat(
      { chunks: ['hi'] },
      {
        email: 'bob@example.com',
        sub: 'sub-bob'
      }
    );
    await postChat(app, body());
    expect(inference.requests[0]?.actor.email).toBe('bob@example.com');
  });

  it.each([
    ['a missing messages array', { model: MODEL, runId: RUN_ID }],
    ['an empty conversation', { messages: [], model: MODEL, runId: RUN_ID }],
    ['an unknown model', { messages: [{ role: 'user', content: 'h' }], model: 'x', runId: RUN_ID }],
    [
      'a malformed run identifier',
      { messages: [{ role: 'user', content: 'h' }], model: MODEL, runId: 'x' }
    ]
  ])('rejects %s with problem details before streaming', async (_label, payload) => {
    const { app } = mountChat();
    const { response } = await postChat(app, payload as Record<string, unknown>);

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rejects a malformed JSON body', async () => {
    const { app } = mountChat();
    const response = await app.request('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    });
    expect(response.status).toBe(400);
  });

  // The limit is enforced before the body is parsed, so an oversized request is refused without
  // being buffered into memory.
  it('rejects a body over the size limit', async () => {
    const { app } = mountChat();
    const oversized = 'x'.repeat(CHAT_BODY_LIMIT_BYTES + 1_024);
    const response = await app.request('/api/chat/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(CHAT_BODY_LIMIT_BYTES + 1_024)
      },
      body: oversized
    });
    expect(response.status).toBe(400);
  });

  // Once the response has started, the status is already sent. A failure therefore arrives as a
  // typed event, because closing the stream would be indistinguishable from a dropped connection.
  it('reports a mid-stream failure as a problem event rather than closing the stream', async () => {
    const { app } = mountChat({
      chunks: ['partial'],
      failMidStream: new Error('provider gave up'),
      failAfter: 1
    });
    const { response, events } = await postChat(app, body());

    expect(response.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'problem']);
  });

  it('does not leak a provider message into the problem event', async () => {
    const { app } = mountChat({
      chunks: ['a'],
      failMidStream: new Error('upstream: prompt "my secret" rejected by internal-host-7'),
      failAfter: 1
    });
    const { events } = await postChat(app, body());

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('my secret');
    expect(serialised).not.toContain('internal-host-7');
  });

  // Before the stream opens, a real status code is still available, so a failure is answered as an
  // ordinary problem-details response rather than as a 200 whose body contains an error. Only once
  // the response has started does a failure have to travel as an event.
  it('answers a provider failure before streaming with problem details', async () => {
    const { app } = mountChat({ failWith: new Error('upstream down') });
    const response = await app.request('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body())
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('does not leak a provider message from a pre-stream failure', async () => {
    const { app } = mountChat({
      failWith: new Error('upstream: prompt "my secret" rejected by internal-host-7')
    });
    const response = await app.request('/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body())
    });

    const text = await response.text();
    expect(text).not.toContain('my secret');
    expect(text).not.toContain('internal-host-7');
  });

  describe('structured logging', () => {
    /**
     * Asserts that nothing sensitive reached the Worker's structured logs.
     *
     * @param logs The captured logs.
     * @returns Nothing; fails the test when a forbidden value is present.
     */
    function expectNoSensitiveData(logs: LogCapture): void {
      const text = logs.text();
      // The prompt and the answer are the visitor's content and belong in neither Worker logs nor
      // gateway logs. The email belongs in AI Gateway metadata only: a structured log is a
      // different retention domain with different access control.
      expect(text).not.toContain('Hello');
      expect(text).not.toContain('alice@example.com');
    }

    it('records a completed run without the prompt, answer, or email', async () => {
      const { app, logs } = mountChat({ chunks: ['Generated answer'] });
      await postChat(app, body());

      expect(logs.entries.some((entry) => entry.message === 'chat_run_completed')).toBe(true);
      expect(logs.text()).not.toContain('Generated answer');
      expectNoSensitiveData(logs);
    });

    it('records a failure without the prompt or email', async () => {
      const { app, logs } = mountChat({
        chunks: ['a'],
        failMidStream: new Error('boom'),
        failAfter: 0
      });
      await postChat(app, body());

      expect(logs.entries.some((entry) => entry.message === 'chat_run_failed')).toBe(true);
      expectNoSensitiveData(logs);
    });

    it('records the run identifier and model, which are safe to retain', async () => {
      const { app, logs } = mountChat();
      await postChat(app, body());

      const completed = logs.entries.find((entry) => entry.message === 'chat_run_completed');
      expect(completed?.context).toMatchObject({ runId: RUN_ID, model: MODEL });
    });
  });
});
