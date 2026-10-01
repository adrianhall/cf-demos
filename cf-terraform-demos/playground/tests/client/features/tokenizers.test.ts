import { describe, expect, it } from 'vitest';
import {
  createBrowserTokenizer,
  DEFAULT_TOKENIZER,
  findTokenizer,
  TOKENIZER_DESCRIPTORS,
  type TokenizerId
} from '../../../src/client/features/view-tokens/tokenizers';

const tokenizer = createBrowserTokenizer();

/**
 * Rebuilds the original text from a token list.
 *
 * @param tokens Tokens produced by the adapter.
 * @returns The concatenated token text.
 */
function reconstruct(tokens: { text: string }[]): string {
  return tokens.map((item) => item.text).join('');
}

describe('TOKENIZER_DESCRIPTORS', () => {
  it('offers several encodings so they can be compared', () => {
    expect(TOKENIZER_DESCRIPTORS.length).toBeGreaterThan(1);
  });

  it('gives every tokenizer a unique identifier', () => {
    const ids = TOKENIZER_DESCRIPTORS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // A count is only meaningful alongside the tokenizer that produced it and a statement of
  // whether that tokenizer is the model's real one. Both fields are therefore mandatory.
  it('states which models each encoding is for, and how exactly', () => {
    for (const item of TOKENIZER_DESCRIPTORS) {
      expect(item.usedBy.length).toBeGreaterThan(0);
      expect(['exact', 'approximate']).toContain(item.fidelity);
    }
  });

  it('declares a vocabulary size and reference context window for each encoding', () => {
    for (const item of TOKENIZER_DESCRIPTORS) {
      expect(item.vocabularySize).toBeGreaterThan(0);
      expect(item.referenceContextWindow).toBeGreaterThan(0);
    }
  });

  it('defaults to a tokenizer that exists in the catalogue', () => {
    expect(findTokenizer(DEFAULT_TOKENIZER)).toBeDefined();
  });
});

describe('findTokenizer', () => {
  it('resolves a known tokenizer', () => {
    expect(findTokenizer('o200k_base')?.name).toBe('o200k_base');
  });

  it('returns undefined for an unknown identifier', () => {
    expect(findTokenizer('not-a-tokenizer')).toBeUndefined();
  });
});

describe('createBrowserTokenizer', () => {
  it('returns no tokens for empty input', async () => {
    await expect(tokenizer.tokenize('', 'o200k_base')).resolves.toEqual([]);
  });

  it('numbers tokens from zero in order', async () => {
    const tokens = await tokenizer.tokenize('Hello brave new world', 'o200k_base');
    expect(tokens.map((item) => item.index)).toEqual(tokens.map((_, index) => index));
  });

  it('gives every token a vocabulary identifier', async () => {
    const tokens = await tokenizer.tokenize('Hello world', 'o200k_base');
    for (const item of tokens) {
      expect(Number.isInteger(item.id)).toBe(true);
      expect(item.id).toBeGreaterThanOrEqual(0);
    }
  });

  // The strongest guarantee the panel can offer: what you see is exactly what you typed, split
  // up. If reconstruction ever failed, the boxes would be showing something other than the input
  // and every count beside them would be describing a different string.
  it.each([
    'Hello world',
    '  leading and trailing  ',
    'line one\nline two\n\nline four',
    '\t\tindented\tcode',
    'café — naïve — Ωmega',
    '日本語のテキストです',
    'Shipped 🎉 by 👨‍👩‍👧‍👦'
  ])('reconstructs %j exactly from its tokens', async (text) => {
    const tokens = await tokenizer.tokenize(text, 'o200k_base');
    expect(reconstruct(tokens)).toBe(text);
  });

  // A byte-pair encoding routinely splits one emoji across several tokens, and the leading pieces
  // decode to nothing. Flagging them is what lets the panel explain the cost rather than drawing
  // mysterious empty boxes.
  it('flags tokens that carry only part of a character', async () => {
    const tokens = await tokenizer.tokenize('🎉', 'o200k_base');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.some((item) => item.partial)).toBe(true);
    expect(reconstruct(tokens)).toBe('🎉');
  });

  it('does not flag an ordinary token as partial', async () => {
    const tokens = await tokenizer.tokenize('Hello', 'o200k_base');
    expect(tokens.every((item) => !item.partial)).toBe(true);
  });

  // A leading space usually belongs to the token that follows it. This is the behaviour the
  // whitespace toggle exists to reveal, so it is worth pinning rather than assuming.
  it('attaches a leading space to the following word', async () => {
    const tokens = await tokenizer.tokenize(' world', 'o200k_base');
    expect(tokens[0]!.text.startsWith(' ')).toBe(true);
  });

  it.each(TOKENIZER_DESCRIPTORS.map((item) => item.id))(
    'loads the %s encoding and reconstructs its input',
    async (id: TokenizerId) => {
      const text = 'Routing every request through the gateway costs nothing extra.';
      const tokens = await tokenizer.tokenize(text, id);
      expect(tokens.length).toBeGreaterThan(0);
      expect(reconstruct(tokens)).toBe(text);
    }
  );

  // Comparing encodings is a large part of why the selector exists. The gain is concentrated in
  // non-English text: on plain English the two encodings often tie, but a newer vocabulary
  // represents Japanese or Arabic in a fraction of the tokens — which is a real difference in
  // what the same sentence costs to send, in favour of the speakers of those languages.
  it('needs far fewer tokens for non-English text under a newer encoding', async () => {
    const text = 'すべてのリクエストはゲートウェイを経由します。';
    const modern = await tokenizer.tokenize(text, 'o200k_base');
    const legacy = await tokenizer.tokenize(text, 'gpt2');
    expect(modern.length).toBeLessThan(legacy.length);
  });

  // The counterpart, asserted so the panel is not read as claiming a universal improvement: on
  // ordinary English the encodings are close, and the multilingual example is what makes the
  // difference visible.
  it('is comparable on plain English prose', async () => {
    const text = 'Every request is routed through the gateway.';
    const modern = await tokenizer.tokenize(text, 'o200k_base');
    const legacy = await tokenizer.tokenize(text, 'gpt2');
    expect(modern.length).toBeLessThanOrEqual(legacy.length);
  });
});
