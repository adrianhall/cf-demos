import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARACTERS,
  MAX_MESSAGES,
  MAX_TEMPERATURE,
  MIN_MAX_TOKENS
} from '../../../src/chat';
import {
  buildChatInput,
  CHAT_SYSTEM_PROMPT,
  isPlausibleRunId,
  validateChatRequest
} from '../../../src/worker/domain/chat';
import { MODEL_DESCRIPTORS } from '../../../src/worker/domain/models';
import { problemWithStatus } from '../support/problem-details';

/**
 * A reviewed Chat model identifier, taken from the catalogue rather than hard-coded so the tests
 * keep working when the reviewed list changes.
 */
const MODEL = MODEL_DESCRIPTORS.find((model) => model.task === 'chat')!.id;

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '0b9d6bb3-0f06-4f9a-9e4e-6d2f4c6f1a11';

/**
 * Builds a valid request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body ready to validate.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: MODEL,
    runId: RUN_ID,
    ...overrides
  };
}

describe('validateChatRequest', () => {
  it('accepts a minimal single-turn request', () => {
    const request = validateChatRequest(body());
    expect(request.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(request.model.id).toBe(MODEL);
    expect(request.runId).toBe(RUN_ID);
  });

  // The descriptor is resolved rather than the identifier passed through, so everything downstream
  // works from a reviewed contract instead of a string from a request body.
  it('resolves the model to its reviewed descriptor', () => {
    expect(validateChatRequest(body()).model.contractVersion).toBeGreaterThan(0);
  });

  it('trims surrounding whitespace from message content', () => {
    const request = validateChatRequest(
      body({ messages: [{ role: 'user', content: '  spaced  ' }] })
    );
    expect(request.messages[0]!.content).toBe('spaced');
  });

  it.each([
    ['a non-object body', 'not an object'],
    ['an array body', [1, 2, 3]],
    ['null', null]
  ])('rejects %s', (_label, input) => {
    expect(() => validateChatRequest(input)).toThrow();
  });

  it('rejects a body with no messages array', () => {
    expect(() => validateChatRequest({ model: MODEL, runId: RUN_ID })).toThrow(/"messages" array/u);
  });

  // Every validation failure is a client error, so the route answers 400 rather than 500 and the
  // browser can show the server's own explanation.
  it('rejects with a 400 problem-details error', () => {
    const error = (() => {
      try {
        validateChatRequest({});
        return undefined;
      } catch (cause: unknown) {
        return cause;
      }
    })();
    expect(error).toMatchObject(problemWithStatus(400));
  });

  it('rejects an empty conversation', () => {
    expect(() => validateChatRequest(body({ messages: [] }))).toThrow(/at least one message/iu);
  });

  // The whole conversation is re-sent and re-charged on every turn, so an unbounded history is a
  // cost that grows quadratically while looking like an ordinary chat.
  it('rejects a conversation longer than the limit', () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({
      role: 'user',
      content: 'hi'
    }));
    expect(() => validateChatRequest(body({ messages }))).toThrow(/at most/iu);
  });

  it('accepts a conversation exactly at the limit', () => {
    const messages = Array.from({ length: MAX_MESSAGES }, (_unused, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${index}`
    }));
    // The final turn must come from the user, so an even count is made to end on one.
    messages[MAX_MESSAGES - 1] = { role: 'user', content: 'last' };
    expect(validateChatRequest(body({ messages })).messages).toHaveLength(MAX_MESSAGES);
  });

  it('rejects an empty or whitespace-only message', () => {
    expect(() =>
      validateChatRequest(body({ messages: [{ role: 'user', content: '   ' }] }))
    ).toThrow(/cannot be empty/iu);
  });

  it('rejects a message longer than the character limit', () => {
    const content = 'x'.repeat(MAX_MESSAGE_CHARACTERS + 1);
    expect(() => validateChatRequest(body({ messages: [{ role: 'user', content }] }))).toThrow(
      /character/iu
    );
  });

  it('rejects a message with non-string content', () => {
    expect(() => validateChatRequest(body({ messages: [{ role: 'user', content: 42 }] }))).toThrow(
      /string content/iu
    );
  });

  // A conversation ending on an assistant turn has nothing to answer, and letting the model
  // improvise a continuation would make the panel's behaviour unpredictable.
  it('rejects a conversation that does not end with a user turn', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' }
    ];
    expect(() => validateChatRequest(body({ messages }))).toThrow(/last message/iu);
  });

  // The system prompt is this panel's own. Accepting one from a caller would turn a narrow Chat API
  // into a general-purpose prompt proxy.
  it('rejects a system role in the conversation', () => {
    const messages = [
      { role: 'system', content: 'You are a pirate' },
      { role: 'user', content: 'Hello' }
    ];
    expect(() => validateChatRequest(body({ messages }))).toThrow(/user.*assistant/iu);
  });

  it('rejects a top-level system prompt field', () => {
    expect(() => validateChatRequest(body({ system: 'You are a pirate' }))).toThrow(/system/iu);
  });

  // The identity comes from the verified Access JWT and from nowhere else. A body carrying one is
  // refused rather than stripped: stripping is a silent correction that makes an attempt look like
  // success and leaves nothing to assert on.
  it.each(['user', 'email', 'actor', 'sub'])('rejects a spoofed "%s" field', (field) => {
    expect(() => validateChatRequest(body({ [field]: 'attacker@example.com' }))).toThrow(
      /verified Cloudflare Access identity/iu
    );
  });

  it('rejects an unknown model', () => {
    expect(() => validateChatRequest(body({ model: '@cf/meta/not-a-real-model' }))).toThrow(
      /reviewed models/iu
    );
  });

  // Looking a model up by identifier alone is how a narrow task API becomes a generic
  // `{ model, input }` passthrough, so the panel is part of the lookup key.
  it('rejects a reviewed model registered against a different panel', () => {
    const other = MODEL_DESCRIPTORS.find((model) => model.task !== 'chat');
    if (other !== undefined) {
      expect(() => validateChatRequest(body({ model: other.id }))).toThrow(/reviewed models/iu);
    }
  });

  it('rejects a missing model', () => {
    expect(() =>
      validateChatRequest({ messages: [{ role: 'user', content: 'h' }], runId: RUN_ID })
    ).toThrow(/model/iu);
  });

  it.each([
    ['too short', 'abc'],
    ['containing a path traversal', '../../etc/passwd'],
    ['containing a slash', 'run/1234567890'],
    ['empty', '']
  ])('rejects a run identifier %s', (_label, runId) => {
    expect(() => validateChatRequest(body({ runId }))).toThrow(/runId/iu);
  });

  it('accepts a temperature within range', () => {
    expect(validateChatRequest(body({ temperature: 0.7 })).temperature).toBe(0.7);
  });

  it('rejects a temperature above the panel maximum', () => {
    expect(() => validateChatRequest(body({ temperature: MAX_TEMPERATURE + 0.1 }))).toThrow(
      /temperature/iu
    );
  });

  it('rejects a negative temperature', () => {
    expect(() => validateChatRequest(body({ temperature: -1 }))).toThrow(/temperature/iu);
  });

  // `NaN` and `Infinity` both serialise to `null` in JSON and would reach the provider as a missing
  // option, making a rejected request look accepted.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])('rejects %s as a temperature', (_label, value) => {
    expect(() => validateChatRequest(body({ temperature: value }))).toThrow(/temperature/iu);
  });

  it('rejects a non-numeric temperature', () => {
    expect(() => validateChatRequest(body({ temperature: '0.7' }))).toThrow(/temperature/iu);
  });

  it('omits an absent temperature rather than defaulting it', () => {
    expect(validateChatRequest(body())).not.toHaveProperty('temperature');
  });

  it('rejects an output budget below the minimum', () => {
    expect(() => validateChatRequest(body({ maxTokens: MIN_MAX_TOKENS - 1 }))).toThrow(
      /maxTokens/iu
    );
  });

  it('accepts an output budget within range', () => {
    expect(validateChatRequest(body({ maxTokens: 512 })).maxTokens).toBe(512);
  });
});

describe('buildChatInput', () => {
  it('prepends the panel system prompt', () => {
    const input = buildChatInput(validateChatRequest(body()), false);
    expect(input.messages[0]).toEqual({ role: 'system', content: CHAT_SYSTEM_PROMPT });
  });

  it('preserves the conversation order after the system prompt', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' }
    ];
    const input = buildChatInput(validateChatRequest(body({ messages })), false);
    expect(input.messages.map((message) => message.content)).toEqual([
      CHAT_SYSTEM_PROMPT,
      'first',
      'second',
      'third'
    ]);
  });

  it('sets the streaming flag from its argument', () => {
    expect(buildChatInput(validateChatRequest(body()), true).stream).toBe(true);
    expect(buildChatInput(validateChatRequest(body()), false).stream).toBe(false);
  });

  it('forwards sampling options only when they were requested', () => {
    const withOptions = buildChatInput(
      validateChatRequest(body({ temperature: 1.1, maxTokens: 256 })),
      true
    );
    expect(withOptions.temperature).toBe(1.1);
    expect(withOptions.max_tokens).toBe(256);

    const without = buildChatInput(validateChatRequest(body()), true);
    expect(without).not.toHaveProperty('temperature');
    expect(without).not.toHaveProperty('max_tokens');
  });
});

describe('isPlausibleRunId', () => {
  it('accepts a UUID', () => {
    expect(isPlausibleRunId(RUN_ID)).toBe(true);
  });

  it.each(['short', '', 'a'.repeat(65), 'has space', 'has/slash', 'has.dot'])(
    'rejects %j',
    (value) => {
      expect(isPlausibleRunId(value)).toBe(false);
    }
  );
});
