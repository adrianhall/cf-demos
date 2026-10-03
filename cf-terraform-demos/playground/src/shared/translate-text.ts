/**
 * @file The Translate Text panel's wire contract. It sits in `src/shared/` beside the other panels'
 *   contracts because both tiers need it, and like them it carries no model descriptors — the
 *   browser learns which models exist and what each accepts from `/api/catalogue`. Three things
 *   make this panel's contract different from every panel before it, and all three come from the
 *   reviewed model contracts rather than from a design preference. **One reviewed model has no
 *   source language at all.** M2M100 translates between a hundred languages and takes
 *   `source_lang`; IndicTrans2 translates _from English only_ and takes no source parameter
 *   whatsoever. So the source selector — and with it the swap action this panel's brief asks for —
 *   exists for one model and genuinely cannot exist for the other. A swap button that silently did
 *   nothing would be worse than an absent one, so the panel states why it is unavailable. See
 *   {@link TranslationControlSupport.fixedSourceLanguage}. **A language code is a per-model
 *   contract, again.** M2M100 takes ISO 639-1 (`hi`); IndicTrans2 takes FLORES-200 style tags
 *   (`hin_Deva`), which name a script as well as a language. The same language is therefore spelled
 *   two different ways, and neither model accepts the other's spelling. The lists are declared per
 *   model rather than merged. **Line breaks are preserved by segmenting, not by hoping.** This is
 *   the deliverable that decides the shape of the whole panel. A translation model is trained on
 *   sentences, and passing a multi-line passage as one string gets the newlines collapsed,
 *   re-ordered, or dropped — which would quietly fail the one formatting promise this panel makes.
 *   So the text is split on line boundaries and each line is translated as its own unit, then
 *   reassembled against the original structure. The consequence is visible and worth teaching:
 *   **one reviewed model accepts an array and costs one inference call, while the other takes a
 *   single string and costs one call per line.** See
 *   {@link TranslationControlSupport.batchesSegments}. Nothing is stored. The source text is
 *   already in the browser and the translation travels back in the response, so there is no second
 *   copy to keep — see `tests/worker/panel-architecture.test.ts`, which holds that boundary.
 */

import type { RunReceipt } from './runs.ts';

/**
 * Longest source text the panel will translate, in characters.
 *
 * Matches the Read Text ceiling deliberately, because the handoff between the two panels is this
 * phase's final deliverable: a translation produced here should fit the panel that reads it aloud
 * without being truncated on arrival. Equal limits make that the common case rather than the lucky
 * one.
 *
 * The server validates every request against it; a browser-side counter is a courtesy, never a
 * control.
 */
export const MAX_TRANSLATION_CHARACTERS = 2_000;

/**
 * Most translatable lines the panel will accept in one request.
 *
 * A **cost** bound rather than a size bound, and the reason it exists is specific to this panel.
 * One reviewed model takes a single string, so each line is a separate inference call — and a
 * pasted document of two hundred short lines would be two hundred paid calls from one click. The
 * character cap alone would not prevent that, because the limit that bites is the number of
 * segments rather than their total length.
 *
 * Twenty-four lines is a comfortable paragraph or a short list, which is what this panel is for.
 * Blank lines do not count against it: they are structure rather than content, and they are never
 * sent to a model.
 */
export const MAX_TRANSLATION_SEGMENTS = 24;

/**
 * One language a model accepts, with the name to show for it.
 *
 * The code and its display name are carried together because the code is not self-explaining in
 * either reviewed spelling: a selector listing `hin_Deva` and `mni_Mtei` is unusable without names,
 * and a selector listing only names could not be validated against the model's own enum.
 */
export interface TranslationLanguage {
  /**
   * The code exactly as the model's schema spells it.
   *
   * Sent to the provider unchanged. The two reviewed models use different standards for the same
   * languages, so this value is only meaningful against the model that declared it.
   */
  code: string;
  /**
   * English name of the language, shown in the selector.
   *
   * Includes the script where the code names one, because IndicTrans2 offers the same language in
   * two scripts — `mni_Beng` and `mni_Mtei` are both Manipuri — and a selector with two identical
   * entries would be a selector a visitor cannot use.
   */
  name: string;
}

/**
 * Which controls one translation model supports and how it spells them.
 *
 * Every field here was read from the model's own schema. A control absent from this declaration is
 * rejected by validation rather than ignored, which is the direction every other panel in this demo
 * takes.
 */
export interface TranslationControlSupport {
  /**
   * The wire name of the target-language field.
   *
   * The reviewed models disagree: M2M100 declares `target_lang` and IndicTrans2 declares
   * `target_language`. Recording the spelling in the reviewed descriptor keeps the mapping beside
   * the contract it came from, rather than in a conditional inside the request builder.
   */
  targetParameterName: 'target_lang' | 'target_language';
  /**
   * The wire name of the source-language field, or `undefined` for a model that has none.
   *
   * Absent for IndicTrans2, which translates from English only and declares no source parameter at
   * all. That is a capability difference rather than a missing feature, and the panel reports it as
   * one.
   */
  sourceParameterName?: 'source_lang';
  /**
   * The language this model always translates from, for a model with no source control.
   *
   * Present exactly when {@link TranslationControlSupport.sourceParameterName} is absent, so the
   * panel can state the fixed source rather than leaving the input side of the translation
   * unlabelled. It is a display and validation value only; it is never sent, because there is no
   * field to send it in.
   */
  fixedSourceLanguage?: TranslationLanguage;
  /**
   * Source languages the model accepts, or `undefined` when its source is fixed.
   *
   * A reviewed allowlist rather than a transcribed enum, because M2M100's schema types
   * `source_lang` as an open string with no enumeration at all. Forwarding an unlisted value would
   * send something unchecked to a provider and surface as an opaque upstream failure instead of a
   * clear refusal.
   */
  sourceLanguages?: readonly TranslationLanguage[];
  /**
   * Target languages the model accepts.
   *
   * Always present: a translation model with no target language would have nothing to translate
   * into. For IndicTrans2 this is transcribed directly from its schema's enum; for M2M100 it is a
   * reviewed subset, for the reason given on {@link TranslationControlSupport.sourceLanguages}.
   */
  targetLanguages: readonly TranslationLanguage[];
  /**
   * Source language selected when the panel first loads, for a model that has the control.
   */
  defaultSourceLanguage?: string;
  /**
   * Target language selected when the panel first loads.
   */
  defaultTargetLanguage: string;
  /**
   * Whether the model accepts an array of texts in one call.
   *
   * The single most consequential field on this type, because it decides what a run costs.
   * IndicTrans2's schema declares `text` as `string | string[]` and returns one translation per
   * input, so a twelve-line passage is **one** inference call. M2M100 takes a single string, so the
   * same passage is **twelve** calls and twelve gateway log entries.
   *
   * The panel states the call count before the request, because it is the thing a visitor would
   * otherwise discover from the bill.
   */
  batchesSegments: boolean;
  /**
   * The field the model puts its translation in, and its shape.
   *
   * Read from the reviewed descriptor rather than guessed by trying keys in turn, as in every other
   * panel: a model whose contract changes then produces a logged, diagnosable refusal instead of
   * quietly matching some other field that happens to hold a string.
   *
   * - `translated_text` — a single string, as M2M100 returns.
   * - `translations` — an array of strings, as IndicTrans2 returns.
   */
  outputField: 'translated_text' | 'translations';
}

/**
 * Every control name a Translate Text request may carry.
 *
 * Used by validation to name the offending control in an error, and by tests to walk the full set
 * rather than a hand-written subset that could fall behind.
 */
export const TRANSLATION_CONTROL_NAMES = ['sourceLanguage', 'targetLanguage'] as const;

/**
 * One Translate Text control; see {@link TRANSLATION_CONTROL_NAMES}.
 */
export type TranslationControlName = (typeof TRANSLATION_CONTROL_NAMES)[number];

/**
 * What the browser posts to have text translated.
 *
 * As in every other panel there is no identity field and no way to supply one: the actor comes from
 * the verified Access JWT alone, and the domain rejects a body carrying one rather than ignoring
 * it.
 *
 * The text is sent as the visitor wrote it, newlines included. Segmenting happens on the server so
 * that one implementation decides what a line is — a browser that split the text itself would be
 * able to stage a request with a different number of paid calls than the server would have made.
 */
export interface TranslateTextRequest {
  /**
   * The text to translate, with its line structure intact.
   */
  text: string;
  /**
   * Reviewed model identifier, which must be registered against the `translate-text` panel.
   */
  model: string;
  /**
   * Opaque run identifier generated by the browser, so the UI can correlate its pending state with
   * the receipt.
   */
  runId: string;
  /**
   * Language to translate from, which must be one the model declares.
   *
   * Omitted for a model whose source is fixed. Supplying one for such a model is refused rather
   * than ignored, because a visitor who sends it believes it took effect.
   */
  sourceLanguage?: string;
  /**
   * Language to translate into, which must be one the model declares.
   */
  targetLanguage: string;
}

/**
 * One line of the source text paired with its translation.
 *
 * Returned as an aligned list rather than only as a reassembled block, so the panel can show the
 * two side by side line for line. That alignment is the panel's primary result presentation, and
 * deriving it in the browser by re-splitting two strings would re-introduce exactly the drift the
 * server-side segmentation exists to prevent.
 */
export interface TranslatedSegment {
  /**
   * The source line, exactly as submitted.
   */
  source: string;
  /**
   * The translated line, or the source unchanged when this line carried no translatable content.
   */
  translated: string;
  /**
   * Whether this line was structural rather than content.
   *
   * A blank line is preserved in position and never sent to a model, so it costs nothing. Marking
   * it lets the panel render the gap without implying a model produced it.
   */
  blank: boolean;
}

/**
 * A completed translation.
 */
export interface Translation {
  /**
   * The full translation, with the source's line structure restored.
   *
   * This is the value the copy action and the Read Text handoff use. It is assembled from the
   * segments rather than concatenated from provider responses, so the line count of the result
   * always equals the line count of the source.
   */
  text: string;
  /**
   * The source and translated lines, aligned; see {@link TranslatedSegment}.
   */
  segments: readonly TranslatedSegment[];
  /**
   * How many lines carried translatable content, and were therefore paid for.
   */
  translatedLineCount: number;
  /**
   * How many inference calls the run actually made.
   *
   * One for a model that batches, one per content line for a model that does not. Reported rather
   * than inferred, so the figure beside the cost is the number of calls that were really made.
   */
  inferenceCallCount: number;
}

/**
 * The settings one run was produced with.
 *
 * Echoed back rather than assumed, so the UI can state what produced a result even after the form
 * has moved on.
 */
export interface AppliedTranslationControls {
  /**
   * Model identifier that produced the translation.
   */
  model: string;
  /**
   * Language translated from, including a model's fixed source.
   *
   * Always present, because a translation with an unstated source language is not interpretable.
   * For a fixed-source model this is that model's own language rather than anything the caller
   * sent.
   */
  sourceLanguage: string;
  /**
   * Language translated into.
   */
  targetLanguage: string;
  /**
   * How many characters were submitted.
   *
   * The text itself is deliberately not echoed: the browser already has it, and a server that
   * returned a visitor's content back to them would put it in one more place for no benefit.
   */
  characterCount: number;
  /**
   * How many inference calls the run made; see {@link Translation.inferenceCallCount}.
   */
  inferenceCallCount: number;
}

/**
 * What the Translate Text endpoint returns on success.
 */
export interface TranslateTextResponse {
  /**
   * The translation; see {@link Translation}.
   */
  translation: Translation;
  /**
   * The run receipt, whose `costStatus` is `pending` whenever a gateway log exists to poll for.
   *
   * This is the first panel whose receipt routinely carries **several** log identifiers, because a
   * non-batching model makes one call per line. The metrics aggregation has always supported that;
   * this panel is the first to exercise it.
   */
  receipt: RunReceipt;
  /**
   * The controls the server actually applied.
   */
  applied: AppliedTranslationControls;
}

/**
 * Splits text into the lines the panel will translate.
 *
 * Shared between the tiers so the browser's predicted call count and the server's actual one are
 * the same calculation. A browser that counted differently would quote a cost the run then did not
 * match, which is worse than quoting none.
 *
 * Normalises CRLF and lone CR to LF first, so text pasted from a Windows editor is not treated as
 * one enormous line — which would defeat the line preservation this panel promises and, for a
 * batching model, silently change the result.
 *
 * @param text Source text as the visitor wrote it.
 * @returns One entry per line, in order, including blank lines. Blank entries are structural and
 *   are never sent to a model.
 */
export function splitTranslationSegments(text: string): string[] {
  return text.replaceAll(/\r\n?/gu, '\n').split('\n');
}

/**
 * Counts the lines of a text that would actually be sent to a model.
 *
 * @param text Source text as the visitor wrote it.
 * @returns How many lines carry translatable content. Blank and whitespace-only lines are excluded,
 *   because they are preserved structurally and cost nothing.
 */
export function countTranslatableLines(text: string): number {
  return splitTranslationSegments(text).filter((line) => line.trim() !== '').length;
}

/**
 * Predicts how many inference calls a translation will make.
 *
 * Exported so the panel can state the figure _before_ the request. This is the one cost-shaped
 * number this panel can honestly quote in advance: both reviewed models bill per token, and a token
 * count is not knowable until the model tokenises the text — but the number of paid calls is known
 * exactly, and it is the figure that surprises people.
 *
 * @param text Source text as the visitor wrote it.
 * @param batchesSegments Whether the selected model accepts an array in one call.
 * @returns The number of calls the run will make, and zero for text with no translatable content.
 */
export function predictInferenceCallCount(text: string, batchesSegments: boolean): number {
  const lines = countTranslatableLines(text);
  if (lines === 0) {
    return 0;
  }

  return batchesSegments ? 1 : lines;
}
