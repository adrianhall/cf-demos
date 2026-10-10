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
});
