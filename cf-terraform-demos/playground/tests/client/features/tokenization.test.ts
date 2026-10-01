import { describe, expect, it } from 'vitest';
import {
  contextWindowUsage,
  describeToken,
  escapeForTable,
  MAX_INPUT_CHARACTERS,
  revealWhitespace,
  summarize,
  truncateInput,
  type Token
} from '../../../src/client/features/view-tokens/tokenization';

/**
 * Builds a token fixture.
 *
 * @param index Position in the sequence.
 * @param id Vocabulary identifier.
 * @param text Decoded text; an empty string marks a partial token.
 * @returns The token.
 */
function token(index: number, id: number, text: string): Token {
  return { index, id, text, partial: text === '' };
}

describe('truncateInput', () => {
  it('leaves a short input untouched', () => {
    expect(truncateInput('hello')).toEqual({ text: 'hello', truncatedCharacters: 0 });
  });

  it('truncates an over-long input and reports how much was dropped', () => {
    const input = 'a'.repeat(MAX_INPUT_CHARACTERS + 50);
    const { text, truncatedCharacters } = truncateInput(input);
    expect([...text]).toHaveLength(MAX_INPUT_CHARACTERS);
    expect(truncatedCharacters).toBe(50);
  });

  // Slicing by UTF-16 unit could cut an emoji in half and leave a lone surrogate, which renders
  // as a replacement character and cannot be tokenized. Counting code points avoids producing a
  // string the rest of the pipeline cannot represent.
  it('never splits a multi-unit character in half', () => {
    const input = '🎉'.repeat(MAX_INPUT_CHARACTERS + 10);
    const { text } = truncateInput(input);
    expect([...text]).toHaveLength(MAX_INPUT_CHARACTERS);
    expect(text).not.toContain('\uFFFD');
    expect(text.endsWith('🎉')).toBe(true);
  });

  it('treats an input of exactly the limit as untruncated', () => {
    const input = 'a'.repeat(MAX_INPUT_CHARACTERS);
    expect(truncateInput(input).truncatedCharacters).toBe(0);
  });
});

describe('summarize', () => {
  it('counts tokens, characters, and words', () => {
    const summary = summarize('hello brave world', 4);
    expect(summary.tokenCount).toBe(4);
    expect(summary.characterCount).toBe(17);
    expect(summary.wordCount).toBe(3);
  });

  it('reports characters per token to two decimal places', () => {
    expect(summarize('abcdefghij', 3).charactersPerToken).toBe(3.33);
  });

  // An empty input must not render "NaN characters per token", which reads as a broken panel
  // rather than as an absence of input.
  it('reports a zero ratio for an empty input rather than NaN', () => {
    expect(summarize('', 0).charactersPerToken).toBe(0);
  });

  // Counting UTF-16 units would report an emoji as two characters and make the ratio wrong in the
  // very case a visitor opened the panel to investigate.
  it('counts an emoji as one character', () => {
    expect(summarize('🎉', 2).characterCount).toBe(1);
  });

  it('ignores runs of whitespace when counting words', () => {
    expect(summarize('  one   two \n three  ', 5).wordCount).toBe(3);
  });
});

describe('revealWhitespace', () => {
  it('marks spaces, tabs, and newlines distinctly', () => {
    expect(revealWhitespace(' a\tb\nc')).toBe('·a→b⏎c');
  });

  // Leading-space tokens are the single most surprising thing about tokenizers, so the mark has
  // to survive at the start of a token rather than being trimmed away.
  it('keeps a leading space visible', () => {
    expect(revealWhitespace(' world')).toBe('·world');
  });

  it('leaves text with no whitespace unchanged', () => {
    expect(revealWhitespace('world')).toBe('world');
  });
});

describe('escapeForTable', () => {
  it('quotes the token and escapes its newlines and tabs', () => {
    expect(escapeForTable('a\nb\tc')).toBe('"a\\nb\\tc"');
  });

  it('escapes backslashes and quotes so the rendering is unambiguous', () => {
    expect(escapeForTable('say "\\"')).toBe('"say \\"\\\\\\""');
  });

  // A table row showing `world` and one showing ` world` are different tokens, and the quotes are
  // what makes that difference visible at all.
  it('makes a leading space visible through the quotes', () => {
    expect(escapeForTable(' world')).toBe('" world"');
  });
});

describe('describeToken', () => {
  // The visual sequence distinguishes tokens by colour and position, neither of which a screen
  // reader conveys. Without this label the whole panel teaches nothing to a non-visual user.
  it('describes position, content, and identifier', () => {
    expect(describeToken(token(3, 2375, ' world'), 12)).toBe('Token 4 of 12, " world", ID 2375');
  });

  // A token carrying half an emoji decodes to nothing. Saying so explains the otherwise baffling
  // observation that one emoji costs several tokens.
  it('explains a partial token instead of describing empty text', () => {
    expect(describeToken(token(0, 139_786, ''), 2)).toBe(
      'Token 1 of 2, part of a multi-byte character, ID 139786'
    );
  });
});

describe('contextWindowUsage', () => {
  it('reports the proportion as a percentage', () => {
    expect(contextWindowUsage(1_280, 128_000)).toBe(1);
  });

  it('rounds to two decimal places', () => {
    expect(contextWindowUsage(7, 128_000)).toBe(0.01);
  });

  // An unknown window must not be rendered as 0%, which reads as "this uses none of it" rather
  // than "we do not know".
  it('returns undefined when the window size is unknown', () => {
    expect(contextWindowUsage(100, undefined)).toBeUndefined();
  });

  it('returns undefined rather than dividing by zero', () => {
    expect(contextWindowUsage(100, 0)).toBeUndefined();
  });
});
