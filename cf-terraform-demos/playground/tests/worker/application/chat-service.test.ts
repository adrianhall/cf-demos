import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../../../src/worker/application/chat/chat-service';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { validateChatRequest } from '../../../src/worker/domain/chat';
import { MODEL_DESCRIPTORS } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { drain, FakeInference } from '../support/fake-inference';

/**
 * A reviewed Chat model identifier.
 */
const MODEL = MODEL_DESCRIPTORS.find((model) => model.task === 'chat')!.id;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'f2a1c0de-1111-4222-8333-444455556666';

/**
 * The verified identity a run is attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'sub-alice' };

/**
 * Builds a validated Chat request.
 *
 * @param overrides Body fields to replace.
 * @returns A validated request, so the service receives the type it requires.
 */
function request(overrides: Record<string, unknown> = {}) {
  return validateChatRequest({
    messages: [{ role: 'user', content: 'Hello' }],
    model: MODEL,
    runId: RUN_ID,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('ChatService.streamChat', () => {
  it('streams the model output as text increments', async () => {
    const inference = new FakeInference({ chunks: ['Hel', 'lo ', 'there'] });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    expect(await drain(run.chunks)).toEqual(['Hel', 'lo ', 'there']);
  });

  // The central invariant, asserted at the application boundary: the service cannot make a call
  // that is not attributed to the verified identity, because the port demands one.
  it('attributes the call to the verified actor', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  it('sends the panel identifier and the reviewed descriptor', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    await (await service.streamChat(request(), ACTOR)).chunks[Symbol.asyncIterator]().next();

    expect(inference.requests[0]?.task).toBe('chat');
    expect(inference.requests[0]?.model.id).toBe(MODEL);
  });

  // `stream: true` is set by the infrastructure client, but the service must ask for streaming in
  // the input it builds, so a non-streaming call cannot reach a streaming route.
  it('builds a streaming input carrying the system prompt', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);

    const input = inference.requests[0]?.input as {
      messages: { role: string }[];
      stream: boolean;
    };
    expect(input.stream).toBe(true);
    expect(input.messages[0]?.role).toBe('system');
  });

  it('produces a completed receipt carrying the gateway log', async () => {
    const inference = new FakeInference({ chunks: ['hi'], logId: 'log-42' });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);
    const receipt = await run.complete();

    expect(receipt.runId).toBe(RUN_ID);
    expect(receipt.task).toBe('chat');
    expect(receipt.status).toBe('completed');
    expect(receipt.logIds).toEqual(['log-42']);
    expect(receipt.gatewayRouted).toBe(true);
  });

  // A log exists, so the cost is pending and the browser should poll. The receipt never claims
  // `available`: it is built long before any log could have propagated.
  it('marks the cost pending when a gateway log exists', async () => {
    const inference = new FakeInference({ chunks: ['hi'], logId: 'log-1' });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);

    expect((await run.complete()).costStatus).toBe('pending');
  });

  // No log means the cost can never resolve, and saying so immediately is better than sending the
  // browser to poll for something that will never exist.
  it('marks the cost unavailable when the gateway assigned no log', async () => {
    const inference = new FakeInference({ chunks: ['hi'], logId: null });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);
    const receipt = await run.complete();

    expect(receipt.costStatus).toBe('unavailable');
    expect(receipt.logIds).toEqual([]);
  });

  it('records the run against the verified owner for the later metrics check', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const runs = createMemoryRunRepository();
    const service = new ChatService({ inference, runs });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);
    await run.complete();

    const record = await runs.find(RUN_ID);
    expect(record?.ownerEmail).toBe('alice@example.com');
    expect(record?.task).toBe('chat');
    expect(record?.logIds).toEqual(['log-1']);
  });

  // A run record exists to authorise and resolve a metrics lookup, and there is nothing to look up
  // until the stream has produced a log. An abandoned stream therefore leaves no record.
  it('records nothing until the stream completes', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const runs = createMemoryRunRepository();
    const service = new ChatService({ inference, runs });

    await service.streamChat(request(), ACTOR);
    expect(await runs.find(RUN_ID)).toBeUndefined();
  });

  it('measures elapsed time from the injected clock', async () => {
    let clock = 1_000;
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({
      inference,
      runs: createMemoryRunRepository(),
      now: () => clock
    });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);
    clock = 1_350;

    expect((await run.complete()).elapsedMs).toBe(350);
  });

  it('records an ISO 8601 start timestamp', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({
      inference,
      runs: createMemoryRunRepository(),
      now: () => Date.parse('2026-04-01T09:15:00.000Z')
    });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);

    expect((await run.complete()).startedAt).toBe('2026-04-01T09:15:00.000Z');
  });

  it('propagates a provider failure that happens before streaming starts', async () => {
    const inference = new FakeInference({ failWith: new Error('upstream down') });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    await expect(service.streamChat(request(), ACTOR)).rejects.toThrow('upstream down');
  });

  it('propagates a failure thrown partway through the stream', async () => {
    const inference = new FakeInference({
      chunks: ['one', 'two'],
      failMidStream: new Error('stream broke'),
      failAfter: 1
    });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request(), ACTOR);
    await expect(drain(run.chunks)).rejects.toThrow('stream broke');
  });

  it('forwards the requested sampling options', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const service = new ChatService({ inference, runs: createMemoryRunRepository() });

    const run = await service.streamChat(request({ temperature: 1.4, maxTokens: 300 }), ACTOR);
    await drain(run.chunks);

    const input = inference.requests[0]?.input as {
      temperature?: number;
      max_tokens?: number;
    };
    expect(input.temperature).toBe(1.4);
    expect(input.max_tokens).toBe(300);
  });

  // Two identities asking the same question must produce different metadata, or the attribution
  // story is decorative. The run identifier differs too, so the logs are separable in the dashboard.
  it('produces different attribution for a second identity asking the same thing', async () => {
    const inference = new FakeInference({ chunks: ['hi'] });
    const runs = createMemoryRunRepository();
    const service = new ChatService({ inference, runs });

    await drain((await service.streamChat(request(), ACTOR)).chunks);
    await drain(
      (
        await service.streamChat(request({ runId: 'bbbbbbbb-1111-4222-8333-444455556666' }), {
          email: 'bob@example.com',
          sub: 'sub-bob'
        })
      ).chunks
    );

    expect(inference.requests.map((entry) => entry.actor.email)).toEqual([
      'alice@example.com',
      'bob@example.com'
    ]);
  });
});

describe('ChatService with a failing repository', () => {
  // A receipt the client never receives would send it polling for a run the server will deny. The
  // save failure surfaces rather than being swallowed.
  it('surfaces a repository failure from complete()', async () => {
    const runs: RunRepositoryPort = {
      save: () => Promise.reject(new Error('store unavailable')),
      find: () => Promise.resolve(undefined)
    };
    const service = new ChatService({ inference: new FakeInference({ chunks: ['hi'] }), runs });

    const run = await service.streamChat(request(), ACTOR);
    await drain(run.chunks);

    await expect(run.complete()).rejects.toThrow('store unavailable');
  });
});
