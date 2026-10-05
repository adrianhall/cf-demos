/**
 * @file Reads a classification out of whichever shape a model returned. The two reviewed models
 *   disagree more fundamentally than any earlier pair: one returns a scored array and the other a
 *   boolean verdict, so this module produces a discriminated union rather than one shape with
 *   optional fields. **The scored path validates structurally, element by element.** A classifier
 *   returns a collection, and the interesting failures are structural rather than textual: an
 *   element that is not an object, a score that is not a number, a score outside the range a
 *   probability can occupy. Each is checked, because one malformed element would otherwise reach
 *   the browser as a confidence bar of unbounded width or a label reading `undefined`. An element
 *   is rejected individually rather than failing the whole run — one bad element out of twenty is a
 *   provider quirk worth logging and skipping — with one exception: if nothing usable survives, the
 *   run fails, because twenty out of twenty is a contract change worth refusing. **The verdict path
 *   refuses to invent a score, and refuses to parse prose.** Llama Guard's output type declares
 *   `response` as `string | { safe, categories }`. The structured branch is read; the string branch
 *   is **not parsed**. A safety verdict extracted by pattern-matching English text would be a
 *   security control resting on a regular expression, and the failure mode is the dangerous
 *   direction — a parse that missed would report unsafe content as safe. Refusing is the only
 *   honest answer, and the reason code says which branch arrived. Category codes are matched
 *   against the reviewed taxonomy rather than trusted. An unrecognised code is carried through as
 *   unrecognised rather than being given a name this demo invented.
 */

import type {
  ClassificationOutcome,
  ClassificationVerdict,
  ReviewedLabel
} from '../../shared/classify-text';
import { rankTextClassificationLabels, type ValidatedClassifyTextRequest } from './classify-text';
import type { ModelDescriptor } from './models';

/**
 * Why a provider's output could not be turned into a classification.
 *
 * Returned rather than thrown so the caller decides the HTTP shape, and so the reason can be logged
 * beside the model identifier — a refusal here and a provider error both surface as a `502`, and
 * they have entirely different fixes.
 *
 * - `unrecognised_shape` — the output was not the kind of value the model's contract declares.
 * - `no_usable_labels` — a scored response arrived but no element survived structural validation.
 * - `missing_verdict` — a verdict response carried no `safe` boolean.
 * - `prose_verdict` — the safety model answered with free text instead of a structured verdict.
 *   Refused rather than parsed; see the file comment.
 */
export type TextClassificationRejection =
  | 'unrecognised_shape'
  | 'no_usable_labels'
  | 'missing_verdict'
  | 'prose_verdict';

/**
 * How many elements of a scored response were unusable, for diagnostics.
 */
export interface ScoredReadDiagnostics {
  /**
   * How many elements the provider returned.
   */
  returned: number;
  /**
   * How many were rejected by structural validation.
   */
  skipped: number;
}

/**
 * The outcome of reading one provider response.
 */
export type ReadClassificationOutcome =
  | {
      ok: true;
      outcome: ClassificationOutcome;
      /**
       * Element counts for a scored response, absent for a verdict.
       */
      diagnostics?: ScoredReadDiagnostics;
    }
  | { ok: false; reason: TextClassificationRejection };

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
 * Reads one scored element, rejecting anything structurally unusable.
 *
 * @param element Candidate element from the provider's array.
 * @returns The label and score, or `undefined` when the element cannot be trusted.
 */
function readScoredElement(element: unknown): { label: string; score: number } | undefined {
  const record = plainObject(element);
  if (record === undefined) {
    return undefined;
  }

  const label = record['label'];
  const score = record['score'];

  if (typeof label !== 'string' || label.trim() === '') {
    return undefined;
  }

  // `Number.isFinite` rather than a `typeof` check alone: `NaN` and `Infinity` are both numbers and
  // both would paint a bar. The range check then bounds it to what a probability can be, so a
  // score of 7 is rejected rather than clamped — clamping would present an impossible value as a
  // plausible one.
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    return undefined;
  }

  return { label, score };
}

/**
 * Matches the category codes a safety model emitted against its reviewed taxonomy.
 *
 * @param codes Raw codes from the provider response.
 * @param model The reviewed descriptor whose taxonomy to match against.
 * @returns The recognised categories with their published names, and the codes that matched
 *   nothing.
 */
function matchCategories(
  codes: readonly string[],
  model: ModelDescriptor
): { categories: ReviewedLabel[]; unrecognised: string[] } {
  const taxonomy = model.textClassificationControls?.labelSet ?? [];
  const categories: ReviewedLabel[] = [];
  const unrecognised: string[] = [];

  for (const code of codes) {
    const match = taxonomy.find((candidate) => candidate.code === code);
    if (match === undefined) {
      // Carried through rather than dropped: a code outside the published set means the model's
      // taxonomy has moved, which is worth surfacing rather than silently narrowing the verdict.
      unrecognised.push(code);
    } else {
      categories.push(match);
    }
  }

  return { categories, unrecognised };
}

/**
 * Reads the classification from one provider response.
 *
 * The expected shape comes from the reviewed descriptor rather than being probed for, as in every
 * other panel: a model whose contract changes then produces a logged, diagnosable refusal instead
 * of quietly matching some other field that happens to hold a plausible value.
 *
 * @param output The provider's raw output.
 * @param request The validated request, whose model names the expected shape and whose controls
 *   decide the ranking.
 * @returns The outcome in the shape the model's contract declares, or a refusal carrying the
 *   reason; see {@link ReadClassificationOutcome}.
 */
export function readTextClassification(
  output: unknown,
  request: ValidatedClassifyTextRequest
): ReadClassificationOutcome {
  const controls = request.model.textClassificationControls;

  if (controls?.outcomeKind === 'verdict') {
    return readVerdict(output, request.model);
  }

  if (controls?.inputShape === 'clef-choice') {
    return readClefChoice(output, request);
  }

  return readScoredLabels(output, request);
}

/**
 * Reads Clef Flash's immutable sentiment choice answer as scored labels.
 *
 * Clef's normal API lets its caller supply arbitrary questions and criteria. This panel does not:
 * `buildClassifyTextInput()` sends one reviewed, immutable sentiment question, then this reader
 * accepts only the matching `answers.sentiment` choice envelope. That is the exact boundary that
 * lets a decision model demonstrate target classification without becoming Evaluate Choices.
 *
 * @param output The provider's raw output.
 * @param request The validated request, whose reviewed labels filter and rank the probabilities.
 * @returns A scored-label outcome, or a refusal when Clef changed its declared choice envelope.
 */
function readClefChoice(
  output: unknown,
  request: ValidatedClassifyTextRequest
): ReadClassificationOutcome {
  const root = plainObject(output);
  const answers = root === undefined ? undefined : plainObject(root['answers']);
  const answer = answers === undefined ? undefined : plainObject(answers['sentiment']);
  const probabilities = answer === undefined ? undefined : plainObject(answer['probabilities']);

  if (answer?.['type'] !== 'choice' || probabilities === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const allowed = request.model.textClassificationControls?.labelSet ?? [];
  const labels: { label: string; score: number }[] = [];
  for (const label of allowed) {
    const score = probabilities[label.code];
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) {
      labels.push({ label: label.code, score });
    }
  }

  if (labels.length === 0) {
    return { ok: false, reason: 'no_usable_labels' };
  }

  return {
    ok: true,
    outcome: {
      kind: 'scored-labels',
      labels: rankTextClassificationLabels(labels, request),
      totalLabels: labels.length
    },
    diagnostics: { returned: allowed.length, skipped: allowed.length - labels.length }
  };
}

/**
 * Reads a scored-label response.
 *
 * @param output The provider's raw output.
 * @param request The validated request, whose controls decide the ranking.
 * @returns The ranked outcome with element counts, or a refusal.
 */
function readScoredLabels(
  output: unknown,
  request: ValidatedClassifyTextRequest
): ReadClassificationOutcome {
  // The schema declares a bare array at the top level, which is unusual enough to be worth
  // asserting: most models in this demo wrap their answer in an object.
  if (!Array.isArray(output)) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const usable: { label: string; score: number }[] = [];
  for (const element of output) {
    const read = readScoredElement(element);
    if (read !== undefined) {
      usable.push(read);
    }
  }

  // One bad element is a quirk to skip; every element bad is a contract change to refuse.
  if (usable.length === 0) {
    return { ok: false, reason: 'no_usable_labels' };
  }

  const labels = rankTextClassificationLabels(usable, request);

  return {
    ok: true,
    outcome: {
      kind: 'scored-labels',
      labels,
      // The count *before* this application's filtering, so the panel can say "showing 1 of the 2
      // labels this model returned" rather than implying the model was asked for one.
      totalLabels: usable.length
    },
    diagnostics: { returned: output.length, skipped: output.length - usable.length }
  };
}

/**
 * Reads a verdict response.
 *
 * @param output The provider's raw output.
 * @param model The reviewed descriptor whose taxonomy names the categories.
 * @returns The verdict outcome, or a refusal.
 */
function readVerdict(output: unknown, model: ModelDescriptor): ReadClassificationOutcome {
  const record = plainObject(output);
  if (record === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const response = record['response'];

  // The string branch its own schema permits. **Deliberately not parsed**: a safety verdict
  // extracted from prose by pattern-matching would be a security control resting on a regular
  // expression, and a missed parse would report unsafe content as safe.
  if (typeof response === 'string') {
    return { ok: false, reason: 'prose_verdict' };
  }

  const structured = plainObject(response);
  if (structured === undefined) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const safe = structured['safe'];
  if (typeof safe !== 'boolean') {
    // Refused rather than defaulted, and the direction matters: defaulting to `true` would
    // announce unverified content as safe, and defaulting to `false` would accuse it on the
    // strength of a malformed response.
    return { ok: false, reason: 'missing_verdict' };
  }

  const rawCategories = structured['categories'];
  const codes = Array.isArray(rawCategories)
    ? rawCategories.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const { categories, unrecognised } = matchCategories(codes, model);

  const verdict: ClassificationVerdict = {
    safe,
    categories,
    unrecognisedCategories: unrecognised
  };

  return { ok: true, outcome: { kind: 'verdict', verdict } };
}
