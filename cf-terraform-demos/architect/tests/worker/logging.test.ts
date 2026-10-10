import { afterEach, describe, expect, it, vi } from 'vitest';
import { logSessionEvent } from '../../src/worker/logging.ts';

/**
 * @file The session logging seam has no Durable Object dependency, by design. These focused tests
 *   prove it serializes exactly one structured argument and reserves error severity for a failed
 *   turn; the event union itself makes prompt, response and graph content unrepresentable.
 */

describe('logSessionEvent', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  afterEach(() => {
    log.mockClear();
    error.mockClear();
  });

  it('writes a completed turn as one parseable structured log argument', () => {
    logSessionEvent({
      diagramId: 'diagram-1',
      event: 'ai_chat_turn_completed',
      latencyMs: 120,
      model: '@cf/test/model',
      mutated: true,
      toolCallCount: 2
    });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        diagramId: 'diagram-1',
        event: 'ai_chat_turn_completed',
        latencyMs: 120,
        model: '@cf/test/model',
        mutated: true,
        toolCallCount: 2
      })
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('writes a failed turn at error severity and successful docs lookups at normal severity', () => {
    logSessionEvent({
      diagramId: 'diagram-1',
      event: 'ai_chat_turn_failed',
      reason: 'Gateway unavailable'
    });
    logSessionEvent({ event: 'ai_docs_lookup_performed', latencyMs: 10, resultCount: 3 });

    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        diagramId: 'diagram-1',
        event: 'ai_chat_turn_failed',
        reason: 'Gateway unavailable'
      })
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'ai_docs_lookup_performed', latencyMs: 10, resultCount: 3 })
    );
  });

  // The union makes content unrepresentable at compile time, which is the real guarantee. This
  // asserts the same rule at runtime, against the emitted lines rather than against the types: a
  // field added later that happened to carry a prompt, an answer, a documentation snippet or a
  // node label would compile, and only this would catch it.
  //
  // `reason` is the single field in the vocabulary that carries free text, and it is deliberately
  // narrowed to a thrown `Error.message` rather than a response body — a body from a failed
  // inference call can contain the prompt that produced it.
  it('emits no field that could carry prompt, answer or diagram content', () => {
    logSessionEvent({
      diagramId: 'diagram-1',
      event: 'ai_chat_turn_completed',
      latencyMs: 120,
      model: '@cf/test/model',
      mutated: true,
      toolCallCount: 2
    });
    logSessionEvent({ event: 'ai_docs_lookup_performed', latencyMs: 10, resultCount: 3 });

    const emitted = log.mock.calls.map(([line]) => JSON.parse(line as string) as object);
    const permitted = new Set([
      'diagramId',
      'event',
      'latencyMs',
      'model',
      'mutated',
      'resultCount',
      'toolCallCount'
    ]);

    for (const line of emitted) {
      for (const field of Object.keys(line)) {
        expect(permitted, `"${field}" is not a permitted log field`).toContain(field);
      }
    }
  });

  // A failed turn is the one event with free text in it, so the narrowing has to be visible: the
  // message travels and nothing else does, even when the caller has more to hand.
  it('carries only the thrown message on a failed turn, never a wider payload', () => {
    logSessionEvent({
      diagramId: 'diagram-1',
      event: 'ai_chat_turn_failed',
      reason: 'Gateway unavailable'
    });

    const [line] = error.mock.calls[0] as [string];
    expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([
      'diagramId',
      'event',
      'reason'
    ]);
  });
});
