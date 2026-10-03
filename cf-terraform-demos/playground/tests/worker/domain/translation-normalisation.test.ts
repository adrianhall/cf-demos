/**
 * @file Tests for reading a translation out of each reviewed model's envelope, and for putting the
 *   translated lines back into the source's structure. The reassembly tests matter as much as the
 *   reading ones: placing a translation on the wrong line is a _plausible_ wrong answer, which is
 *   worse than a missing one because nothing looks broken.
 */

import { describe, expect, it } from 'vitest';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  assembleTranslation,
  readTranslations
} from '../../../src/worker/domain/translation-normalisation';

/**
 * The reviewed translation models, in catalogue order.
 */
const [M2M100, INDIC] = modelsForTask('translate-text');

/**
 * Unwraps a successful read, failing the test when it was a refusal.
 *
 * @param outcome The reader's result.
 * @returns The translations.
 */
function expectOk(outcome: ReturnType<typeof readTranslations>): string[] {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error('expected translations');
  }
  return outcome.translations;
}

describe('the M2M100 envelope', () => {
  it('reads a single translated string', () => {
    const outcome = readTranslations({ translated_text: "L'eau est froide" }, M2M100!, 1);

    expect(expectOk(outcome)).toEqual(["L'eau est froide"]);
  });

  // `translated_text`, not `translations`. Reading the wrong key would produce an empty result
  // against a perfectly valid response, which is exactly the failure a reviewed envelope prevents.
  it('reads the declared field rather than the other model\u2019s', () => {
    expect(readTranslations({ translations: ['wrong shape'] }, M2M100!, 1).ok).toBe(false);
  });

  it('refuses a non-string value in its field', () => {
    expect(readTranslations({ translated_text: 42 }, M2M100!, 1).ok).toBe(false);
    expect(readTranslations({ translated_text: null }, M2M100!, 1).ok).toBe(false);
  });

  it('refuses an empty or whitespace-only translation', () => {
    expect(readTranslations({ translated_text: '' }, M2M100!, 1)).toEqual({
      ok: false,
      reason: 'empty_translation'
    });
    expect(readTranslations({ translated_text: '   ' }, M2M100!, 1)).toEqual({
      ok: false,
      reason: 'empty_translation'
    });
  });

  // Its output type carries a second branch that is the async-queue acknowledgement rather than a
  // translation. This demo never asks for batch mode, so receiving one means the request was
  // routed differently than intended — and a `request_id` is a plausible-looking string that must
  // not reach the page as a translation.
  it('refuses an async acknowledgement rather than rendering the request id', () => {
    expect(readTranslations({ request_id: 'abc-123' }, M2M100!, 1)).toEqual({
      ok: false,
      reason: 'async_acknowledgement'
    });
  });

  // Distinguished from a missing field so a log says whether the call was queued or the contract
  // changed. They need entirely different fixes.
  it('distinguishes an acknowledgement from a missing field', () => {
    expect(readTranslations({ unexpected: 'envelope' }, M2M100!, 1)).toEqual({
      ok: false,
      reason: 'missing_translation'
    });
  });
});

describe('the IndicTrans2 envelope', () => {
  it('reads an array of translations', () => {
    const outcome = readTranslations({ translations: ['एक', 'दो'] }, INDIC!, 2);

    expect(expectOk(outcome)).toEqual(['एक', 'दो']);
  });

  it('reads the declared field rather than the other model\u2019s', () => {
    expect(readTranslations({ translated_text: 'wrong shape' }, INDIC!, 1).ok).toBe(false);
  });

  it('refuses a non-array value in its field', () => {
    expect(readTranslations({ translations: 'not an array' }, INDIC!, 1).ok).toBe(false);
  });

  // An array is not trusted merely because it is an array: `[null, "text"]` would otherwise reach
  // the page with the word "null" as a translated line.
  it('refuses a non-string entry inside the array', () => {
    expect(readTranslations({ translations: ['ok', null] }, INDIC!, 2).ok).toBe(false);
    expect(readTranslations({ translations: [42] }, INDIC!, 1).ok).toBe(false);
  });

  it('refuses an empty array', () => {
    expect(readTranslations({ translations: [] }, INDIC!, 1)).toEqual({
      ok: false,
      reason: 'empty_translation'
    });
  });

  // Alignment, not pedantry. These translations are about to be placed against specific source
  // lines, so a count mismatch means every placement after the gap would be wrong.
  it('refuses a count that does not match the lines it was given', () => {
    expect(readTranslations({ translations: ['one'] }, INDIC!, 3)).toEqual({
      ok: false,
      reason: 'wrong_cardinality'
    });
    expect(readTranslations({ translations: ['a', 'b', 'c'] }, INDIC!, 2)).toEqual({
      ok: false,
      reason: 'wrong_cardinality'
    });
  });

  it('accepts an exact count match', () => {
    expect(expectOk(readTranslations({ translations: ['a', 'b', 'c'] }, INDIC!, 3))).toHaveLength(
      3
    );
  });
});

describe('refusing unusable output', () => {
  it('refuses a non-object', () => {
    expect(readTranslations('a translation', M2M100!, 1)).toEqual({
      ok: false,
      reason: 'unrecognised_shape'
    });
    expect(readTranslations(null, M2M100!, 1).ok).toBe(false);
    expect(readTranslations([], M2M100!, 1).ok).toBe(false);
  });
});

describe('reassembling the source structure', () => {
  it('pairs every source line with its translation', () => {
    const result = assembleTranslation(['one', 'two'], [0, 1], ['un', 'deux'], 2);

    expect(result.segments).toEqual([
      { source: 'one', translated: 'un', blank: false },
      { source: 'two', translated: 'deux', blank: false }
    ]);
    expect(result.text).toBe('un\ndeux');
  });

  // The behaviour that makes the whole segmentation worthwhile, and the one a naive implementation
  // gets wrong: consuming the translations in order would put "trois" on the blank line.
  it('keeps a blank line in the middle in its original position', () => {
    const result = assembleTranslation(['one', '', 'three'], [0, 2], ['un', 'trois'], 2);

    expect(result.text).toBe('un\n\ntrois');
    expect(result.segments[1]).toEqual({ source: '', translated: '', blank: true });
    expect(result.segments[2]?.translated).toBe('trois');
  });

  it('handles several consecutive blank lines', () => {
    const result = assembleTranslation(['a', '', '', 'b'], [0, 3], ['A', 'B'], 2);

    expect(result.text).toBe('A\n\n\nB');
  });

  it('handles a leading blank line', () => {
    const result = assembleTranslation(['', 'a'], [1], ['A'], 1);

    expect(result.text).toBe('\nA');
  });

  it('handles a trailing blank line', () => {
    const result = assembleTranslation(['a', ''], [0], ['A'], 1);

    expect(result.text).toBe('A\n');
  });

  // The line preservation promise, stated as an invariant rather than as a set of examples.
  it('always produces exactly as many lines as the source had', () => {
    const lines = ['a', '', 'b', '', '', 'c'];
    const indices = [0, 2, 5];
    const result = assembleTranslation(lines, indices, ['A', 'B', 'C'], 3);

    expect(result.segments).toHaveLength(lines.length);
    expect(result.text.split('\n')).toHaveLength(lines.length);
  });

  it('preserves a whitespace-only line exactly as submitted', () => {
    const result = assembleTranslation(['a', '  ', 'b'], [0, 2], ['A', 'B'], 2);

    expect(result.segments[1]).toEqual({ source: '  ', translated: '  ', blank: true });
  });

  // Losing a line would change the structure this panel promises to preserve, so the source is kept
  // instead. Visibly incomplete beats silently shorter.
  it('keeps the source line when a translation is missing for it', () => {
    const result = assembleTranslation(['one', 'two'], [0, 1], ['un'], 2);

    expect(result.segments[1]).toEqual({ source: 'two', translated: 'two', blank: false });
    expect(result.text).toBe('un\ntwo');
  });

  it('reports the translated line count and the call count', () => {
    const result = assembleTranslation(['a', '', 'b'], [0, 2], ['A', 'B'], 1);

    // Two lines of content, delivered in one batched call.
    expect(result.translatedLineCount).toBe(2);
    expect(result.inferenceCallCount).toBe(1);
  });

  it('reports the call count it was given rather than deriving one', () => {
    const result = assembleTranslation(['a', 'b'], [0, 1], ['A', 'B'], 2);
    expect(result.inferenceCallCount).toBe(2);
  });

  it('handles a source with nothing to translate', () => {
    const result = assembleTranslation([''], [], [], 0);

    expect(result.text).toBe('');
    expect(result.translatedLineCount).toBe(0);
    expect(result.segments[0]?.blank).toBe(true);
  });
});
