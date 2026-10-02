import { describe, expect, it } from 'vitest';
import {
  newRunId,
  toRequestMessages,
  type ConversationTurn
} from '../../../src/client/features/chat/conversation';
import { MAX_MESSAGES } from '../../../src/shared/chat';

/**
 * Builds a conversation turn.
 *
 * @param overrides Fields to replace on a completed user turn.
 * @returns A turn ready to use.
 */
function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return { id: 'turn-1', role: 'user', content: 'Hello', streaming: false, ...overrides };
}

describe('toRequestMessages', () => {
  it('converts completed turns into wire messages', () => {
    const messages = toRequestMessages([
      turn({ id: 'a', role: 'user', content: 'Hi' }),
      turn({ id: 'b', role: 'assistant', content: 'Hello' })
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' }
    ]);
  });

  // A turn still streaming has no business being replayed as history, and sending a half-finished
  // assistant turn would ask the model to continue something the visitor has not even read yet.
  it('omits a turn that is still streaming', () => {
    const messages = toRequestMessages([
      turn({ id: 'a', content: 'Hi' }),
      turn({ id: 'b', role: 'assistant', content: 'partial', streaming: true })
    ]);

    expect(messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  // A failed run leaves an empty assistant turn. Sending it would put a blank message in the
  // history, which the server rejects — correctly.
  it('omits an empty turn left by a failed run', () => {
    const messages = toRequestMessages([
      turn({ id: 'a', content: 'Hi' }),
      turn({ id: 'b', role: 'assistant', content: '' })
    ]);

    expect(messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('omits a whitespace-only turn', () => {
    expect(toRequestMessages([turn({ content: '   ' })])).toEqual([]);
  });

  // Trimming client-side keeps a long conversation working rather than failing validation once it
  // grows past the server's bound.
  it('keeps only the most recent turns when the history is too long', () => {
    const turns = Array.from({ length: MAX_MESSAGES + 5 }, (_unused, index) =>
      turn({ id: `t${index}`, content: `message ${index}` })
    );

    const messages = toRequestMessages(turns);
    expect(messages).toHaveLength(MAX_MESSAGES);
    // The oldest turns are dropped: an older turn is the one a visitor is least likely to be
    // referring to.
    expect(messages[0]?.content).toBe('message 5');
    expect(messages.at(-1)?.content).toBe(`message ${MAX_MESSAGES + 4}`);
  });

  it('keeps a history exactly at the limit intact', () => {
    const turns = Array.from({ length: MAX_MESSAGES }, (_unused, index) =>
      turn({ id: `t${index}`, content: `m${index}` })
    );
    expect(toRequestMessages(turns)).toHaveLength(MAX_MESSAGES);
  });

  it('returns an empty list for an empty conversation', () => {
    expect(toRequestMessages([])).toEqual([]);
  });

  it('preserves the order of the turns it keeps', () => {
    const messages = toRequestMessages([
      turn({ id: 'a', content: 'first' }),
      turn({ id: 'b', role: 'assistant', content: 'second' }),
      turn({ id: 'c', content: 'third' })
    ]);
    expect(messages.map((message) => message.content)).toEqual(['first', 'second', 'third']);
  });
});

describe('newRunId', () => {
  it('produces a distinct identifier each time', () => {
    expect(newRunId()).not.toBe(newRunId());
  });

  // The identifier ends up in AI Gateway metadata and in a URL path, so it has to match the shape
  // the server will accept.
  it('produces an identifier the server will accept', () => {
    expect(newRunId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
  });
});
