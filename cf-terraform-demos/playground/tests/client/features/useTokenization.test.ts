import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import {
  MAX_INPUT_CHARACTERS,
  MAX_RENDERED_TOKENS
} from '../../../src/client/features/view-tokens/tokenization';
import type { TokenizerPort } from '../../../src/client/features/view-tokens/tokenizers';
import { useTokenization } from '../../../src/client/features/view-tokens/useTokenization';

/**
 * A tokenizer that splits on spaces, so tests never load a real vocabulary table.
 *
 * The composable's job is orchestration — debouncing, truncating, discarding stale results — and
 * none of that depends on the encoding. Injecting a trivial tokenizer keeps these tests fast and
 * makes their failures point at the composable rather than at a byte-pair implementation.
 *
 * @param options `delay` resolves after a given number of milliseconds; `fail` rejects.
 * @returns The fake port and a spy recording its calls.
 */
function fakeTokenizer(options: { delay?: number; fail?: boolean } = {}) {
  const tokenize = vi.fn(async (text: string, tokenizerId: string) => {
    if (options.delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delay));
    }
    if (options.fail) {
      throw new Error('could not load encoding');
    }
    return text
      .split(' ')
      .filter((word) => word !== '')
      .map((word, index) => ({
        index,
        // Encode the tokenizer in the identifier so a test can tell which encoding produced a
        // result, which is what makes the stale-result assertions meaningful.
        id: tokenizerId.length * 1_000 + index,
        text: word,
        partial: false
      }));
  });

  return { tokenizer: { tokenize } satisfies TokenizerPort, tokenize };
}

/**
 * Advances fake timers past the debounce and lets pending promises settle.
 *
 * @param ms Milliseconds to advance.
 * @returns A promise fulfilled once the composable has published its result.
 */
async function settle(ms = 200): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTokenization', () => {
  it('tokenizes the input after the debounce elapses', async () => {
    const { tokenizer } = fakeTokenizer();
    const state = useTokenization({ tokenizer });

    state.input.value = 'one two three';
    await settle();

    expect(state.result.value?.summary.tokenCount).toBe(3);
  });

  // Tokenizing rebuilds every box, so running it per keystroke makes typing feel sticky. The
  // debounce is what keeps a fast typist from queueing a pass per character.
  it('collapses a burst of typing into a single tokenization', async () => {
    const { tokenizer, tokenize } = fakeTokenizer();
    const state = useTokenization({ tokenizer });
    await settle();
    tokenize.mockClear();

    state.input.value = 'o';
    await nextTick();
    state.input.value = 'on';
    await nextTick();
    state.input.value = 'one';
    await settle();

    expect(tokenize).toHaveBeenCalledTimes(1);
    expect(tokenize).toHaveBeenLastCalledWith('one', 'o200k_base');
  });

  it('re-tokenizes when the tokenizer changes', async () => {
    const { tokenizer, tokenize } = fakeTokenizer();
    const state = useTokenization({ tokenizer });
    state.input.value = 'one two';
    await settle();
    tokenize.mockClear();

    state.tokenizerId.value = 'cl100k_base';
    await settle();

    expect(tokenize).toHaveBeenCalledWith('one two', 'cl100k_base');
  });

  // Encodings load on demand, so two runs can overlap when a visitor switches tokenizer while
  // typing. Without the sequence guard the slower first run can resolve last and overwrite the
  // correct result — a bug that only shows up on a cold cache, which is to say in front of an
  // audience rather than in development.
  it('discards a slow earlier result when a newer one has started', async () => {
    const slow = fakeTokenizer({ delay: 500 });
    const state = useTokenization({ tokenizer: slow.tokenizer, debounceMs: 0 });

    state.input.value = 'first input here';
    await vi.advanceTimersByTimeAsync(10);
    state.input.value = 'second';
    await settle(1_000);

    expect(state.result.value?.summary.tokenCount).toBe(1);
  });

  it('marks the result pending while a tokenization is in flight', async () => {
    const slow = fakeTokenizer({ delay: 300 });
    const state = useTokenization({ tokenizer: slow.tokenizer, debounceMs: 0 });

    state.input.value = 'one two';
    await vi.advanceTimersByTimeAsync(10);
    expect(state.pending.value).toBe(true);

    await settle(1_000);
    expect(state.pending.value).toBe(false);
  });

  it('truncates an over-long input and reports the overflow', async () => {
    const { tokenizer } = fakeTokenizer();
    const state = useTokenization({ tokenizer });

    state.input.value = 'a'.repeat(MAX_INPUT_CHARACTERS + 25);
    await settle();

    expect(state.result.value?.truncatedCharacters).toBe(25);
  });

  // Thousands of token boxes would be slow to render and useless to read. The counts still
  // describe the whole input, so capping the drawing does not falsify the summary.
  it('caps the tokens it renders while still counting all of them', async () => {
    const { tokenizer } = fakeTokenizer();
    const state = useTokenization({ tokenizer });

    state.input.value = Array.from({ length: MAX_RENDERED_TOKENS + 40 }, (_, i) => `w${i}`).join(
      ' '
    );
    await settle();

    expect(state.result.value?.summary.tokenCount).toBe(MAX_RENDERED_TOKENS + 40);
    expect(state.visibleTokens.value).toHaveLength(MAX_RENDERED_TOKENS);
    expect(state.hiddenTokenCount.value).toBe(40);
  });

  it('reports no hidden tokens for a short input', async () => {
    const { tokenizer } = fakeTokenizer();
    const state = useTokenization({ tokenizer });

    state.input.value = 'one two three';
    await settle();

    expect(state.hiddenTokenCount.value).toBe(0);
  });

  // A failed encoding load leaves the visitor with text they can still see and edit, so it is
  // recorded rather than thrown.
  it('records a tokenizer load failure without throwing', async () => {
    const failing = fakeTokenizer({ fail: true });
    const state = useTokenization({ tokenizer: failing.tokenizer });

    state.input.value = 'one two';
    await settle();

    expect(state.error.value).toMatch(/could not be loaded/iu);
    expect(state.pending.value).toBe(false);
  });

  it('clears a previous error once tokenization succeeds again', async () => {
    const flaky = {
      tokenize: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue([{ index: 0, id: 1, text: 'one', partial: false }])
    } satisfies TokenizerPort;
    const state = useTokenization({ tokenizer: flaky, debounceMs: 0 });

    state.input.value = 'one';
    await settle();
    expect(state.error.value).not.toBeNull();

    state.input.value = 'one two';
    await settle();
    expect(state.error.value).toBeNull();
  });
});
