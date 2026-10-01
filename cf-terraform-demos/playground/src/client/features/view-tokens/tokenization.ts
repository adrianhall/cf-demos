/**
 * @file Pure tokenization domain for the View Tokens panel. Everything here is a plain function
 *   over plain data, with no tokenizer library, no DOM, and no network. That keeps the interesting
 *   rules — exact reconstruction, whitespace rendering, partial-byte tokens, truncation — testable
 *   in isolation, which matters because they are precisely the cases a visitor will try first and a
 *   naive implementation gets wrong.
 */

/**
 * Longest input the panel will tokenize.
 *
 * Tokenization is synchronous and runs on the UI thread, so an unbounded paste — a whole book, a
 * minified bundle — would freeze the tab. Truncating and saying so is better than either hanging or
 * silently dropping the overflow.
 */
export const MAX_INPUT_CHARACTERS = 20_000;

/**
 * Most token boxes rendered at once.
 *
 * Each token is a separate DOM element with its own label, so a 20,000-character input could ask
 * the browser for thousands of them. The summary and the table still describe the whole input; only
 * the visual sequence is capped, because nobody reads the eight-thousandth coloured box.
 */
export const MAX_RENDERED_TOKENS = 1_500;

/**
 * One token, as the panel displays it.
 */
export interface Token {
  /**
   * Zero-based position in the token sequence.
   */
  index: number;
  /**
   * Numeric token identifier in the tokenizer's vocabulary.
   */
  id: number;
  /**
   * The text this token decodes to on its own.
   *
   * Empty for a token that carries only part of a multi-byte character: byte-pair encodings
   * routinely split one emoji or accented letter across several tokens, and the leading pieces
   * decode to nothing on their own. See {@link Token.partial}.
   */
  text: string;
  /**
   * Whether this token decodes to no text by itself.
   *
   * Surfaced rather than hidden because it explains something a visitor will otherwise find
   * baffling: why an emoji "costs" several tokens but appears only once in the sequence. The panel
   * labels these instead of rendering a confusing empty box.
   */
  partial: boolean;
}

/**
 * Counts and ratios describing a tokenized input.
 */
export interface TokenSummary {
  /**
   * Number of tokens.
   */
  tokenCount: number;
  /**
   * Number of characters in the (possibly truncated) input, counted as Unicode code points rather
   * than UTF-16 units so an emoji counts as one character rather than two.
   */
  characterCount: number;
  /**
   * Number of whitespace-separated words, for an intuitive comparison against the token count.
   */
  wordCount: number;
  /**
   * Characters per token, rounded to two decimal places. The familiar "about four characters per
   * token" figure is an English-prose average; showing the real ratio makes it obvious how badly
   * that rule of thumb fails on code, other scripts, and emoji.
   */
  charactersPerToken: number;
}

/**
 * The result of tokenizing one input.
 */
export interface TokenizationResult {
  /**
   * Every token in the input, including those beyond the rendering cap.
   */
  tokens: Token[];
  /**
   * Counts for the whole input.
   */
  summary: TokenSummary;
  /**
   * Characters removed because the input exceeded {@link MAX_INPUT_CHARACTERS}, or zero.
   */
  truncatedCharacters: number;
}

/**
 * Limits an input to the length the panel will tokenize.
 *
 * Splits by code point rather than by UTF-16 unit, so a cut never lands in the middle of a
 * surrogate pair and produces a lone half-character that no tokenizer can represent.
 *
 * @param input Raw text from the editor.
 * @returns The text to tokenize and how many characters were dropped.
 */
export function truncateInput(input: string): { text: string; truncatedCharacters: number } {
  const codePoints = [...input];
  if (codePoints.length <= MAX_INPUT_CHARACTERS) {
    return { text: input, truncatedCharacters: 0 };
  }

  return {
    text: codePoints.slice(0, MAX_INPUT_CHARACTERS).join(''),
    truncatedCharacters: codePoints.length - MAX_INPUT_CHARACTERS
  };
}

/**
 * Computes the counts shown above the token sequence.
 *
 * @param text The text that was tokenized, after any truncation.
 * @param tokenCount Number of tokens the tokenizer produced.
 * @returns Character, word, and token counts with their ratio.
 */
export function summarize(text: string, tokenCount: number): TokenSummary {
  const characterCount = [...text].length;
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  return {
    tokenCount,
    characterCount,
    wordCount: words.length,
    // Guard the division rather than letting an empty input render "NaN characters per token",
    // which looks like a bug in the panel rather than an absence of input.
    charactersPerToken: tokenCount === 0 ? 0 : Math.round((characterCount / tokenCount) * 100) / 100
  };
}

/**
 * Renders a token's text with its whitespace made visible.
 *
 * Whitespace is where tokenization is least intuitive: a leading space usually belongs to the
 * _following_ word's token, so `" world"` is one token and `"world"` is a different one. A panel
 * that drew both as `world` would hide the single most surprising thing about tokenizers.
 *
 * The replacements are the conventional typographic symbols — `·` for a space, `→` for a tab, `⏎`
 * for a newline — rather than boxes, so the shape of the text survives.
 *
 * @param text Token text as the tokenizer decoded it.
 * @returns The same text with spaces, tabs, and newlines replaced by visible marks.
 */
export function revealWhitespace(text: string): string {
  return text.replaceAll(' ', '·').replaceAll('\t', '→').replaceAll('\n', '⏎');
}

/**
 * Escapes a token's text for the token table.
 *
 * The table shows tokens as quoted literals with escape sequences, because a column that rendered a
 * newline as an actual line break would make the row heights jump and hide the difference between
 * `"\n"` and `"\n\n"`.
 *
 * @param text Token text as the tokenizer decoded it.
 * @returns A quoted, escaped representation such as `"\n"` or `" world"`.
 */
export function escapeForTable(text: string): string {
  const escaped = text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r');
  return `"${escaped}"`;
}

/**
 * Builds the accessible label for one token.
 *
 * The visual sequence distinguishes tokens by colour and spacing, neither of which a screen reader
 * conveys. Without a label, the sequence reads as an undifferentiated run of text and the panel
 * teaches nothing to anyone not looking at it.
 *
 * @param token The token to describe.
 * @param total Total number of tokens, so the position is meaningful.
 * @returns A phrase such as `Token 4 of 12, " world", ID 2375`.
 */
export function describeToken(token: Token, total: number): string {
  const position = `Token ${token.index + 1} of ${total}`;
  if (token.partial) {
    return `${position}, part of a multi-byte character, ID ${token.id}`;
  }
  return `${position}, ${escapeForTable(token.text)}, ID ${token.id}`;
}

/**
 * Reports how much of a model's context window an input would occupy.
 *
 * @param tokenCount Number of tokens in the input.
 * @param contextWindowTokens Size of the reference model's context window.
 * @returns The proportion as a percentage rounded to two decimal places, or `undefined` when the
 *   window size is unknown or zero — an unknown denominator must not be rendered as 0%, which would
 *   read as "this uses none of it".
 */
export function contextWindowUsage(
  tokenCount: number,
  contextWindowTokens: number | undefined
): number | undefined {
  if (contextWindowTokens === undefined || contextWindowTokens <= 0) {
    return undefined;
  }
  return Math.round((tokenCount / contextWindowTokens) * 10_000) / 100;
}
