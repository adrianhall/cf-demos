/**
 * @file Reads a translation out of whichever shape a model returned, and puts the translated lines
 *   back into the source's structure. Two separate jobs, both in the domain tier because both are
 *   pure logic over plain data with their own failure modes. **Reading the output.** The reviewed
 *   models disagree: M2M100 returns `{ translated_text: "…" }` and IndicTrans2 returns `{
 *   translations: ["…"] }`. The field is chosen from the reviewed descriptor rather than probed
 *   for, as in every other panel. Guessing would be more forgiving and considerably worse — a
 *   changed contract would find some other string field and present it as a translation, turning a
 *   contract break into a plausible but wrong result that nobody notices. M2M100's output type also
 *   carries a second branch, `{ request_id }`, which is the async-queue acknowledgement rather than
 *   a translation. This demo never asks for batch mode, so receiving one means the request was
 *   routed differently than intended — and it must be refused rather than rendered, because a
 *   `request_id` is a plausible-looking string that is not a translation. **Reassembling.** The
 *   translations come back only for the lines that had content, so they are placed by their
 *   original indices rather than concatenated in order. Doing it by position is what makes a blank
 *   line in the middle of a passage survive; consuming a list in order would work for text whose
 *   only blank line is at the end, which is exactly the shape a test would accidentally use.
 */

import type { TranslatedSegment, Translation } from '../../shared/translate-text';
import type { ModelDescriptor } from './models';

/**
 * Why a provider's output could not be turned into a translation.
 *
 * Returned rather than thrown so the caller decides the HTTP shape, and so the reason can be logged
 * beside the model identifier — a refusal here and a provider error both surface as a `502`, and
 * they have entirely different fixes.
 *
 * - `unrecognised_shape` — the output was not an object at all.
 * - `missing_translation` — the declared field was absent.
 * - `empty_translation` — the field was present but held nothing usable.
 * - `async_acknowledgement` — the provider acknowledged a queued batch instead of translating.
 * - `wrong_cardinality` — a batching model returned a different number of translations than the
 *   number of lines it was given, so they cannot be aligned to the source.
 */
export type TranslationRejection =
  | 'unrecognised_shape'
  | 'missing_translation'
  | 'empty_translation'
  | 'async_acknowledgement'
  | 'wrong_cardinality';

/**
 * The outcome of reading translations out of one provider response.
 */
export type ReadTranslationsOutcome =
  | { ok: true; translations: string[] }
  | { ok: false; reason: TranslationRejection };

/**
 * Reads a plain object from an untrusted value.
 *
 * @param value Candidate value from a provider response.
 * @returns The object, or `undefined` when it is absent, null, or an array.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the translations from one provider response.
 *
 * The expected field and shape come from the reviewed descriptor. `expectedCount` is checked for a
 * batching model because an array that does not line up with its input cannot be reassembled: a
 * model returning two translations for three lines would otherwise have its output silently
 * misaligned against the source, which is a wrong answer rather than a missing one.
 *
 * @param output The provider's raw output.
 * @param model The reviewed descriptor, which names the output field and whether it batches.
 * @param expectedCount How many translations this call should have produced.
 * @returns The translations in order, or a refusal carrying the reason; see
 *   {@link ReadTranslationsOutcome}.
 */
export function readTranslations(
  output: unknown,
  model: ModelDescriptor,
  expectedCount: number
): ReadTranslationsOutcome {
  const record = plainObject(output);
  if (record === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const controls = model.translationControls;
  const field = controls?.outputField ?? 'translated_text';

  // Checked before the expected field, because this branch is a *successful* provider response that
  // contains no translation. Reporting it as a missing field would send a reader looking for a
  // contract change when the real cause is that the call was queued as a batch.
  if (!Object.hasOwn(record, field) && Object.hasOwn(record, 'request_id')) {
    return { ok: false, reason: 'async_acknowledgement' };
  }

  const value = record[field];

  if (controls?.outputField === 'translations') {
    if (!Array.isArray(value)) {
      return { ok: false, reason: 'missing_translation' };
    }

    // Each entry is checked individually rather than the array being trusted because it is an
    // array. A provider returning `[null, "text"]` would otherwise reach the page with the word
    // "null" as a translated line.
    const translations: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        return { ok: false, reason: 'missing_translation' };
      }
      translations.push(entry);
    }

    if (translations.length === 0) {
      return { ok: false, reason: 'empty_translation' };
    }

    // Alignment, not pedantry: these translations are about to be placed against specific source
    // lines, and a count mismatch means every placement after the gap would be wrong.
    if (translations.length !== expectedCount) {
      return { ok: false, reason: 'wrong_cardinality' };
    }

    return { ok: true, translations };
  }

  if (typeof value !== 'string') {
    return { ok: false, reason: 'missing_translation' };
  }

  if (value.trim() === '') {
    return { ok: false, reason: 'empty_translation' };
  }

  return { ok: true, translations: [value] };
}

/**
 * Puts translated lines back into the source's line structure.
 *
 * Placement is by original index, which is what makes a blank line survive in the middle of a
 * passage. A blank line is carried through unchanged and marked structural, so the panel can render
 * the gap without implying a model produced it.
 *
 * @param lines Every source line, in order, including blank ones.
 * @param contentLineIndices Indices of the lines that were sent for translation.
 * @param translations The translations, in the same order as `contentLineIndices`.
 * @param inferenceCallCount How many calls produced these translations, recorded on the result.
 * @returns The assembled translation, whose line count always equals the source's; see
 *   {@link Translation}.
 */
export function assembleTranslation(
  lines: readonly string[],
  contentLineIndices: readonly number[],
  translations: readonly string[],
  inferenceCallCount: number
): Translation {
  // Keyed by source index so a translation lands on the line it came from rather than on the nth
  // non-blank line, which are the same thing only until a passage has an internal blank line.
  const byIndex = new Map<number, string>();
  contentLineIndices.forEach((lineIndex, position) => {
    const translated = translations[position];
    if (translated !== undefined) {
      byIndex.set(lineIndex, translated);
    }
  });

  const segments: TranslatedSegment[] = lines.map((line, index) => {
    const blank = line.trim() === '';

    return {
      source: line,
      // A blank line keeps itself. A content line with no translation keeps its source too, which
      // is a deliberate choice: losing a line would change the structure this panel promises to
      // preserve, and showing the untranslated original is visibly incomplete rather than
      // silently shorter.
      translated: blank ? line : (byIndex.get(index) ?? line),
      blank
    };
  });

  return {
    // Joined with `\n` because the source was normalised to `\n` at validation, so the result's
    // line count is the source's by construction rather than by coincidence.
    text: segments.map((segment) => segment.translated).join('\n'),
    segments,
    translatedLineCount: contentLineIndices.length,
    inferenceCallCount
  };
}
