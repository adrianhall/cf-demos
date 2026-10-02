import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '../../../src/client/features/chat/useChat';
import { ApiError } from '../../../src/client/services/playground-api';
import { useLedgerStore } from '../../../src/client/stores/ledger';
import {
  MAX_MESSAGE_CHARACTERS,
  type ChatRequest,
  type ChatStreamEvent
} from '../../../src/shared/chat';
import type { RunReceipt } from '../../../src/shared/runs';

/**
 * A completed run receipt with no gateway log, so tests do not poll for a cost unless they mean to.
 *
 * @param overrides Fields to replace.
 * @returns A receipt for a `completed` event.
 */
function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    runId: 'run-1',
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    gatewayRouted: true,
    logIds: [],
    status: 'completed',
    costStatus: 'unavailable',
    elapsedMs: 300,
    startedAt: '2026-04-01T09:15:00.000Z',
    ...overrides
  };
}

/**
 * Builds a streaming transport that replays a fixed event sequence.
 *
 * @param events Events to yield, in order.
 * @returns The transport and the requests it received, so a test can assert what was sent.
 */
function fakeTransport(events: ChatStreamEvent[]) {
  const requests: ChatRequest[] = [];

  /**
   * Replays the configured events.
   *
   * @param request The Chat request.
   * @returns An async generator over the events.
   */
  async function* transport(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    requests.push(request);
    for (const event of events) {
      yield event;
    }
  }

  return { transport: transport as never, requests };
}

/**
 * Builds a transport that rejects before yielding anything, as the real one does when the server
 * refuses the request outright.
 *
 * Written as an async function returning a rejected iterable rather than as a generator that only
 * throws: a generator with no `yield` is an odd shape that the linter rightly objects to.
 *
 * @param cause Error to reject with.
 * @returns A transport whose first iteration step rejects.
 */
function rejectingTransport(cause: Error) {
  return () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(cause)
    })
  });
}

/**
 * The event sequence of an ordinary successful run.
 *
 * @param text Chunks to stream.
 * @param final Receipt for the completed event.
 * @returns The full event sequence.
 */
function successfulRun(text: string[], final: RunReceipt = receipt()): ChatStreamEvent[] {
  return [
    { type: 'start', runId: final.runId, model: final.model },
    ...text.map((chunk): ChatStreamEvent => ({ type: 'delta', text: chunk })),
    { type: 'completed', receipt: final }
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useChat', () => {
  it('appends the prompt as a user turn and streams the answer into an assistant turn', async () => {
    const { transport } = fakeTransport(successfulRun(['Hel', 'lo']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi there';
    await chat.send();

    expect(chat.turns.value).toHaveLength(2);
    expect(chat.turns.value[0]).toMatchObject({ role: 'user', content: 'Hi there' });
    expect(chat.turns.value[1]).toMatchObject({ role: 'assistant', content: 'Hello' });
  });

  it('clears the draft once the prompt is sent', async () => {
    const { transport } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    expect(chat.draft.value).toBe('');
  });

  it('marks the assistant turn as no longer streaming once the run ends', async () => {
    const { transport } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    expect(chat.turns.value[1]?.streaming).toBe(false);
    expect(chat.streaming.value).toBe(false);
  });

  it('records the receipt from the completed event', async () => {
    const { transport } = fakeTransport(successfulRun(['ok'], receipt({ runId: 'run-xyz' })));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    expect(chat.receipt.value?.runId).toBe('run-xyz');
  });

  it('sends the selected model and a fresh run identifier', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    expect(requests[0]?.model).toBe('model-a');
    expect(requests[0]?.runId).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
  });

  // The request must not carry an identity field: the server rejects one, and the identity comes
  // from the verified Access JWT alone.
  it('sends no identity field in the request', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    // Checked as top-level keys rather than by string search: `role: "user"` is a legitimate part
    // of every message, so a substring assertion would fail on correct output.
    expect(Object.keys(requests[0]!).sort()).toEqual(['messages', 'model', 'runId']);
  });

  it('sends only the role and content of each message', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    for (const message of requests[0]!.messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'role']);
    }
  });

  it('sends the conversation history on a follow-up turn', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['first answer']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'first question';
    await chat.send();
    chat.draft.value = 'second question';
    await chat.send();

    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' }
    ]);
  });

  // The model must never be asked to continue a blank turn, which is what the empty assistant turn
  // would be if it were included in the request.
  it('does not send the empty assistant turn it just created', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();

    expect(requests[0]?.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('forwards a temperature only when one was chosen', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    chat.draft.value = 'Hi';
    await chat.send();
    expect(requests[0]).not.toHaveProperty('temperature');

    chat.temperature.value = 1.3;
    chat.draft.value = 'Again';
    await chat.send();
    expect(requests[1]?.temperature).toBe(1.3);
  });

  describe('canSend', () => {
    it('is false for an empty draft', () => {
      const { transport } = fakeTransport([]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      expect(chat.canSend.value).toBe(false);
    });

    it('is false for a whitespace-only draft', () => {
      const { transport } = fakeTransport([]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      chat.draft.value = '   ';
      expect(chat.canSend.value).toBe(false);
    });

    it('is true for a non-empty draft', () => {
      const { transport } = fakeTransport([]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      chat.draft.value = 'Hi';
      expect(chat.canSend.value).toBe(true);
    });

    it('is false for a draft over the server\u2019s per-message limit', () => {
      const { transport } = fakeTransport([]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      chat.draft.value = 'x'.repeat(MAX_MESSAGE_CHARACTERS + 1);
      expect(chat.canSend.value).toBe(false);
    });
  });

  it('does nothing when send is called with an empty draft', async () => {
    const { transport, requests } = fakeTransport(successfulRun(['ok']));
    const chat = useChat({ initialModel: 'model-a', stream: transport });

    await chat.send();
    expect(requests).toEqual([]);
    expect(chat.turns.value).toEqual([]);
  });

  describe('failures', () => {
    it('shows the server\u2019s explanation from a problem event', async () => {
      const { transport } = fakeTransport([
        { type: 'start', runId: 'run-1', model: 'model-a' },
        { type: 'problem', status: 502, title: 'Failed', detail: 'The model was unavailable.' }
      ]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });

      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.error.value).toBe('The model was unavailable.');
    });

    it('keeps the partial answer when a problem event arrives mid-stream', async () => {
      const { transport } = fakeTransport([
        { type: 'start', runId: 'run-1', model: 'model-a' },
        { type: 'delta', text: 'partial answer' },
        { type: 'problem', status: 502, title: 'Failed', detail: 'Stopped early.' }
      ]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });

      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.turns.value[1]?.content).toBe('partial answer');
    });

    it('shows the API error message when the request is rejected outright', async () => {
      const chat = useChat({
        initialModel: 'model-a',
        stream: rejectingTransport(new ApiError(400, 'Send at least one message.')) as never
      });
      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.error.value).toBe('Send at least one message.');
    });

    // A non-API failure is a transport problem, and its message is written for a developer. The
    // visitor gets something actionable instead.
    it('shows a generic message for an unexpected transport failure', async () => {
      const chat = useChat({
        initialModel: 'model-a',
        stream: rejectingTransport(new TypeError('network down')) as never
      });
      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.error.value).toMatch(/could not be streamed/iu);
      expect(chat.error.value).not.toContain('network down');
    });

    it('stops streaming after a failure', async () => {
      const chat = useChat({
        initialModel: 'model-a',
        stream: rejectingTransport(new ApiError(500, 'nope')) as never
      });
      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.streaming.value).toBe(false);
    });

    it('clears a previous error when a new run starts', async () => {
      const { transport } = fakeTransport(successfulRun(['ok']));
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      chat.error.value = 'stale message';

      chat.draft.value = 'Hi';
      await chat.send();

      expect(chat.error.value).toBeNull();
    });

    // A failed run has no receipt, so it must not reach the cost meter: a run counted with a cost
    // that can never resolve is exactly the "pending forever" state the meter exists to avoid.
    it('does not record a run in the ledger when the run failed', async () => {
      const { transport } = fakeTransport([
        { type: 'start', runId: 'run-1', model: 'model-a' },
        { type: 'problem', status: 502, title: 'Failed', detail: 'nope' }
      ]);
      const ledger = useLedgerStore();
      const chat = useChat({ initialModel: 'model-a', stream: transport });

      chat.draft.value = 'Hi';
      await chat.send();

      expect(ledger.ledger.runCount).toBe(0);
    });
  });

  describe('cancellation', () => {
    it('aborts the request in flight', async () => {
      let captured: AbortSignal | undefined;

      /**
       * A transport that waits for its signal to abort.
       *
       * @param _request The Chat request, unused.
       * @param signal Abort signal from the composable.
       * @returns An async generator that yields one delta then rejects on abort.
       */
      async function* slow(
        _request: ChatRequest,
        signal?: AbortSignal
      ): AsyncGenerator<ChatStreamEvent> {
        captured = signal;
        yield { type: 'delta', text: 'partial' };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }

      const chat = useChat({ initialModel: 'model-a', stream: slow as never });
      chat.draft.value = 'Hi';

      const pending = chat.send();
      // Give the generator a turn to yield its first delta and register the abort listener.
      await Promise.resolve();
      await Promise.resolve();
      chat.cancel();
      await pending;

      expect(captured?.aborted).toBe(true);
      expect(chat.streaming.value).toBe(false);
    });

    // Cancel is the visitor's own action, not a failure, so it leaves no error. The partial answer
    // stays on screen: it was generated, and it was paid for.
    it('leaves no error message and keeps the partial answer', async () => {
      /**
       * A transport that yields one delta then aborts.
       *
       * @param _request The Chat request, unused.
       * @param signal Abort signal from the composable.
       * @returns An async generator.
       */
      async function* slow(
        _request: ChatRequest,
        signal?: AbortSignal
      ): AsyncGenerator<ChatStreamEvent> {
        yield { type: 'delta', text: 'kept text' };
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }

      const chat = useChat({ initialModel: 'model-a', stream: slow as never });
      chat.draft.value = 'Hi';

      const pending = chat.send();
      await Promise.resolve();
      await Promise.resolve();
      chat.cancel();
      await pending;

      expect(chat.error.value).toBeNull();
      expect(chat.turns.value[1]?.content).toBe('kept text');
    });

    it('is harmless when nothing is in flight', () => {
      const { transport } = fakeTransport([]);
      const chat = useChat({ initialModel: 'model-a', stream: transport });
      expect(() => chat.cancel()).not.toThrow();
    });
  });

  describe('reset', () => {
    it('clears the conversation and the receipt', async () => {
      const { transport } = fakeTransport(successfulRun(['ok']));
      const chat = useChat({ initialModel: 'model-a', stream: transport });

      chat.draft.value = 'Hi';
      await chat.send();
      chat.reset();

      expect(chat.turns.value).toEqual([]);
      expect(chat.receipt.value).toBeUndefined();
    });

    // The conversation is this panel's state; the ledger is the session's. Clearing a chat must not
    // erase the record of money already spent.
    it('leaves the session cost totals untouched', async () => {
      const { transport } = fakeTransport(successfulRun(['ok']));
      const ledger = useLedgerStore();
      const chat = useChat({ initialModel: 'model-a', stream: transport });

      chat.draft.value = 'Hi';
      await chat.send();
      const before = ledger.ledger.runCount;
      chat.reset();

      expect(ledger.ledger.runCount).toBe(before);
    });
  });
});
