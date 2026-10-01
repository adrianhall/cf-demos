/**
 * @file Tokenizer catalogue and the browser adapter that loads them. Tokenization here is genuinely
 *   local: the encodings are bundled, the work happens on the visitor's machine, and nothing is
 *   sent anywhere. That is the panel's whole premise, so the adapter has no network path at all
 *   rather than a network path that happens to be unused.
 */

import type { Token } from './tokenization.ts';

/**
 * How closely a tokenizer matches the models it is offered as a stand-in for.
 *
 * This distinction is the honest part of the panel. Cloudflare's catalog spans models from many
 * families, and their exact tokenizers are not all available as a browser library. Rather than
 * quietly tokenizing a Llama prompt with an OpenAI encoding and presenting the count as fact, a
 * tokenizer says which models it is exact for and which it merely approximates.
 */
export type TokenizerFidelity =
  /**
   * The encoding these models actually use. Counts are exact.
   */
  | 'exact'
  /**
   * A different encoding of similar design. Counts are indicative, not exact.
   */
  | 'approximate';

/**
 * Identifier of a bundled tokenizer.
 */
export type TokenizerId = 'o200k_base' | 'cl100k_base' | 'p50k_base' | 'gpt2';

/**
 * One tokenizer a visitor can choose.
 */
export interface TokenizerDescriptor {
  /**
   * Stable identifier, also the encoding's conventional name.
   */
  id: TokenizerId;
  /**
   * Human-facing name for the selector.
   */
  name: string;
  /**
   * Which models this encoding is used by, in plain language.
   */
  usedBy: string;
  /**
   * Whether counts from this tokenizer are exact or indicative; see {@link TokenizerFidelity}.
   */
  fidelity: TokenizerFidelity;
  /**
   * Number of entries in the encoding's vocabulary, shown so the relationship between vocabulary
   * size and token count is visible: a larger vocabulary generally means fewer tokens for the same
   * text.
   */
  vocabularySize: number;
  /**
   * A representative context window in tokens, used only to illustrate what proportion of a model's
   * window an input would occupy. Approximate by nature, and labelled as such.
   */
  referenceContextWindow: number;
}

/**
 * Every tokenizer the panel offers, in selector order.
 *
 * Four encodings rather than one, because comparing them is the point: the same sentence costing
 * materially more tokens under an older encoding is a far more convincing demonstration of why
 * tokenization matters than any single number.
 */
export const TOKENIZER_DESCRIPTORS: readonly TokenizerDescriptor[] = [
  {
    id: 'o200k_base',
    name: 'o200k_base',
    usedBy: 'GPT-4o and the GPT-5 family',
    fidelity: 'exact',
    vocabularySize: 200_006,
    referenceContextWindow: 128_000
  },
  {
    id: 'cl100k_base',
    name: 'cl100k_base',
    usedBy: 'GPT-4, GPT-3.5 Turbo, and the text-embedding-3 models',
    fidelity: 'exact',
    vocabularySize: 100_277,
    referenceContextWindow: 128_000
  },
  {
    id: 'p50k_base',
    name: 'p50k_base',
    usedBy: 'The Codex and older text-davinci models',
    fidelity: 'exact',
    vocabularySize: 50_281,
    referenceContextWindow: 8_192
  },
  {
    id: 'gpt2',
    name: 'gpt2',
    usedBy: 'GPT-2, and useful as a baseline for how much modern encodings improved',
    fidelity: 'exact',
    vocabularySize: 50_257,
    referenceContextWindow: 1_024
  }
];

/**
 * Default tokenizer, chosen because it backs the most current models.
 */
export const DEFAULT_TOKENIZER: TokenizerId = 'o200k_base';

/**
 * What the panel needs from a tokenizer.
 *
 * Narrow on purpose: the panel asks for tokens and gets tokens. Keeping the surface this small is
 * what makes the feature testable without loading a 2 MB encoding table into every unit test, and
 * what would let a WebAssembly tokenizer be swapped in later without touching the UI.
 */
export interface TokenizerPort {
  /**
   * Splits text into tokens.
   *
   * @param text Text to tokenize.
   * @param tokenizerId Which bundled encoding to use.
   * @returns The tokens, in order.
   * @throws {Error} When the encoding cannot be loaded.
   */
  tokenize(text: string, tokenizerId: TokenizerId): Promise<Token[]>;
}

/**
 * Shape of the parts of `gpt-tokenizer`'s encoding modules that this adapter uses.
 */
interface EncodingModule {
  /**
   * Encodes text into token identifiers.
   */
  encode: (text: string) => number[];
  /**
   * Decodes token identifiers back into text.
   */
  decode: (tokens: number[]) => string;
}

/**
 * Loaded encodings, kept so switching back to a tokenizer is instant.
 *
 * Each encoding is a sizeable vocabulary table. Caching them trades memory for responsiveness,
 * which is the right way round for a panel whose entire appeal is that it reacts as you type.
 */
const encodingCache = new Map<TokenizerId, EncodingModule>();

/**
 * Loads one encoding, fetching its chunk on first use.
 *
 * The dynamic imports are written as a literal switch rather than a templated path so the bundler
 * can see each one and split it into its own chunk. A templated import would make the bundler
 * include every encoding in one chunk, which is exactly the cost this lazy loading avoids: the
 * shell should not ship four vocabulary tables to a visitor who opens Chat.
 *
 * @param tokenizerId Encoding to load.
 * @returns The encoding's `encode` and `decode` functions.
 * @throws {Error} When the encoding's chunk cannot be fetched, typically because the visitor went
 *   offline between loading the page and choosing a tokenizer.
 */
async function loadEncoding(tokenizerId: TokenizerId): Promise<EncodingModule> {
  const cached = encodingCache.get(tokenizerId);
  if (cached) {
    return cached;
  }

  let loaded: EncodingModule;
  switch (tokenizerId) {
    case 'o200k_base':
      loaded = await import('gpt-tokenizer/esm/encoding/o200k_base');
      break;
    case 'cl100k_base':
      loaded = await import('gpt-tokenizer/esm/encoding/cl100k_base');
      break;
    case 'p50k_base':
      loaded = await import('gpt-tokenizer/esm/encoding/p50k_base');
      break;
    case 'gpt2':
      loaded = await import('gpt-tokenizer/esm/encoding/gpt2');
      break;
  }

  encodingCache.set(tokenizerId, loaded);
  return loaded;
}

/**
 * Looks up a tokenizer descriptor.
 *
 * @param id Candidate tokenizer identifier.
 * @returns The descriptor, or `undefined` when the identifier is unknown.
 */
export function findTokenizer(id: string): TokenizerDescriptor | undefined {
  return TOKENIZER_DESCRIPTORS.find((tokenizer) => tokenizer.id === id);
}

/**
 * The browser tokenizer adapter.
 *
 * @returns A {@link TokenizerPort} backed by lazily loaded bundled encodings.
 */
export function createBrowserTokenizer(): TokenizerPort {
  return {
    /**
     * Splits text into tokens using a bundled encoding.
     *
     * Each token is decoded individually so the panel can show what that token alone represents. A
     * token carrying only part of a multi-byte character decodes to an empty string, which is
     * reported as `partial` rather than hidden — it is the explanation for why one emoji can cost
     * several tokens.
     *
     * @param text Text to tokenize.
     * @param tokenizerId Encoding to use.
     * @returns The tokens, in order. An empty input yields an empty array rather than an error.
     * @throws {Error} When the encoding's chunk cannot be loaded.
     */
    async tokenize(text: string, tokenizerId: TokenizerId): Promise<Token[]> {
      if (text === '') {
        return [];
      }

      const encoding = await loadEncoding(tokenizerId);
      return encoding.encode(text).map((id, index) => {
        const decoded = encoding.decode([id]);
        return { index, id, text: decoded, partial: decoded === '' };
      });
    }
  };
}
