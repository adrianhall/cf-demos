/**
 * @file Stateful composable behind the View Tokens panel.
 */

import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import {
  MAX_RENDERED_TOKENS,
  summarize,
  truncateInput,
  type Token,
  type TokenizationResult
} from './tokenization.ts';
import { createBrowserTokenizer, type TokenizerId, type TokenizerPort } from './tokenizers.ts';

/**
 * Delay before tokenizing after the last keystroke.
 *
 * Tokenizing is fast, but it is synchronous and it rebuilds every token box. Running it on every
 * keystroke makes a long paste feel sticky; a short debounce makes it feel immediate while
 * collapsing a burst of typing into one pass.
 */
export const DEBOUNCE_MS = 150;

/**
 * Options for {@link useTokenization}.
 */
export interface UseTokenizationOptions {
  /**
   * Tokenizer implementation. Defaults to the bundled browser tokenizer; tests inject a fake so
   * they never load a vocabulary table.
   */
  tokenizer?: TokenizerPort;
  /**
   * Debounce in milliseconds. Tests pass `0` to tokenize on the next tick rather than waiting.
   */
  debounceMs?: number;
}

/**
 * What the View Tokens panel binds to.
 */
export interface UseTokenizationResult {
  /**
   * Editable input text.
   */
  input: Ref<string>;
  /**
   * Selected tokenizer.
   */
  tokenizerId: Ref<TokenizerId>;
  /**
   * The latest tokenization, or `undefined` before the first run completes.
   */
  result: Ref<TokenizationResult | undefined>;
  /**
   * Whether a tokenization is in flight, so the panel can mark its output as stale rather than
   * blanking it. Replacing a visible result with a spinner on every keystroke is more disruptive
   * than briefly showing the previous one.
   */
  pending: Ref<boolean>;
  /**
   * Message from a failed tokenizer load, or `null`.
   */
  error: Ref<string | null>;
  /**
   * Tokens to render as boxes, capped for performance.
   */
  visibleTokens: Ref<Token[]>;
  /**
   * How many tokens exist beyond {@link visibleTokens}, or zero.
   */
  hiddenTokenCount: Ref<number>;
}

/**
 * Drives tokenization for the View Tokens panel.
 *
 * All of this happens in the browser. There is no fetch, no run identifier, and no cost: the
 * composable deliberately has no access to the API client or the cost ledger, so the panel cannot
 * start contributing to either by accident.
 *
 * @param options Tokenizer implementation and debounce; see {@link UseTokenizationOptions}.
 * @returns Reactive state for the panel; see {@link UseTokenizationResult}.
 */
export function useTokenization(options: UseTokenizationOptions = {}): UseTokenizationResult {
  const tokenizer = options.tokenizer ?? createBrowserTokenizer();
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;

  const input = ref('');
  const tokenizerId = ref<TokenizerId>('o200k_base');
  // `shallowRef` because the result is replaced wholesale and can hold thousands of tokens;
  // making every one of them deeply reactive would cost far more than it could ever save.
  const result = shallowRef<TokenizationResult | undefined>(undefined);
  const pending = ref(false);
  const error = ref<string | null>(null);

  let debounceHandle: ReturnType<typeof setTimeout> | undefined;
  /**
   * Sequence number of the most recently started tokenization.
   *
   * Tokenizing is asynchronous because the encoding loads on demand, so two runs can be in flight
   * when a visitor switches tokenizer mid-type. Without this guard the slower first run could
   * resolve last and overwrite the correct result with a stale one — a bug that only appears on a
   * cold cache or a slow connection, which is to say rarely and confusingly.
   */
  let latestRun = 0;

  /**
   * Tokenizes the current input and publishes the result.
   *
   * @returns A promise fulfilled once the result or the error has been recorded. A failure is
   *   stored in `error` rather than thrown, because the panel can still show the input.
   */
  async function run(): Promise<void> {
    const runId = ++latestRun;
    const { text, truncatedCharacters } = truncateInput(input.value);
    const selected = tokenizerId.value;

    pending.value = true;
    try {
      const tokens = await tokenizer.tokenize(text, selected);
      if (runId !== latestRun) {
        return;
      }
      result.value = { tokens, summary: summarize(text, tokens.length), truncatedCharacters };
      error.value = null;
    } catch {
      if (runId !== latestRun) {
        return;
      }
      error.value = 'That tokenizer could not be loaded. Check your connection and try again.';
    } finally {
      if (runId === latestRun) {
        pending.value = false;
      }
    }
  }

  watch(
    [input, tokenizerId],
    () => {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => void run(), debounceMs);
    },
    { immediate: true }
  );

  const visibleTokens = computed(() => result.value?.tokens.slice(0, MAX_RENDERED_TOKENS) ?? []);
  const hiddenTokenCount = computed(() =>
    Math.max(0, (result.value?.tokens.length ?? 0) - MAX_RENDERED_TOKENS)
  );

  return { input, tokenizerId, result, pending, error, visibleTokens, hiddenTokenCount };
}
