/**
 * @file Interpreting the dataset's scalar values for display. Every scalar this API returns is a
 *   string, including the ones that look numeric — `mass`, `diameter`, `population`, `episodeId`.
 *   The source dataset puts sentinel text in those positions wherever a value is missing, and it
 *   does so often: `"unknown"` appears 313 times across the seed data, `"none"` 76 times, `"n/a"`
 *   20 times, and 17 of the 60 planets have an unknown population. The rule this file exists to
 *   enforce is UISPEC §2.1: **do not parse, format, or unit-annotate these values.** Rendering
 *   `population` as `1,000,000,000` is wrong the moment the value is `"unknown"`, and there is no
 *   way to know in advance which rows those are. So the explorer shows exactly what the dataset
 *   says — and confines itself to recognising when what the dataset says is "nothing".
 */

/**
 * What a scalar value turned out to mean.
 */
export type AttributeValueKind =
  /**
   * Real information, to be shown as-is.
   */
  | 'value'
  /**
   * The dataset does not record this. A planet's population of `"unknown"`.
   */
  | 'unknown'
  /**
   * The field does not apply to this entity. A droid's `gender` of `"n/a"`.
   */
  | 'notApplicable'
  /**
   * The value is genuinely nothing, which is itself information: a character with no hair has
   * `"none"`, and that is a fact rather than a gap.
   */
  | 'none';

/**
 * A scalar value, classified for display.
 */
export interface AttributeValue {
  /**
   * What the raw text turned out to mean.
   */
  kind: AttributeValueKind;
  /**
   * Text to display. The original string for real values; a normalised phrase for sentinels.
   */
  text: string;
}

/**
 * Sentinel spellings, mapped to what each one means and how it should read.
 *
 * Normalising the wording is deliberate. The upstream dataset spells absence three ways for reasons
 * of its own, and surfacing all three would make the interface look inconsistent for no benefit to
 * the reader. What is _not_ normalised is the distinction between them: "unrecorded" and "not
 * applicable" are genuinely different statements, and UISPEC §2.1 asks that the difference be kept
 * where it is real.
 *
 * Keys are lowercase; lookup lowercases its input, because the dataset is not perfectly consistent
 * about case.
 */
const SENTINELS: Readonly<Record<string, AttributeValue>> = {
  'unknown': { kind: 'unknown', text: 'Unknown' },
  'n/a': { kind: 'notApplicable', text: 'Not applicable' },
  'none': { kind: 'none', text: 'None' },
  'indefinite': { kind: 'value', text: 'indefinite' }
};

/**
 * Classify a raw scalar value for display.
 *
 * `indefinite` — a species' average lifespan — is deliberately treated as a real value despite
 * appearing in the same positions as the sentinels. It is an answer, not the absence of one: a
 * species that does not die of old age is a fact about that species.
 *
 * @param raw Value exactly as the API returned it, or `null`/`undefined` if the field was absent.
 * @returns The classified value. An absent or empty field is reported as `unknown`, because a blank
 *   cell in a detail view is indistinguishable from a rendering bug and tells the reader nothing.
 */
export function classifyAttributeValue(raw: string | null | undefined): AttributeValue {
  if (raw === null || raw === undefined) {
    return { kind: 'unknown', text: 'Unknown' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: 'unknown', text: 'Unknown' };
  }

  return SENTINELS[trimmed.toLowerCase()] ?? { kind: 'value', text: trimmed };
}

/**
 * Whether a classified value represents missing information rather than data.
 *
 * Drives the de-emphasis UISPEC §2.1 asks for. `none` counts as a real answer here — "no hair" is
 * information — so only the two genuine absences are treated as gaps.
 *
 * @param value Classified value.
 * @returns `true` when the value should be presented as an absence of information.
 */
export function isMissing(value: AttributeValue): boolean {
  return value.kind === 'unknown' || value.kind === 'notApplicable';
}
