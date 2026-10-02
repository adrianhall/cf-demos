/**
 * @file Pure presentation helpers for a ranked, scored result. Plain functions over plain data: no
 *   Vue, no fetch, no DOM. They live beside {@link RankedLabels} rather than inside the Classify
 *   Image feature folder because Classify Text in a later phase ranks labels the same way, and the
 *   wording of a score is exactly the thing that must not be re-invented differently in two panels.
 *   Every function here is about saying what a score is without overstating it. A classifier's
 *   score is the model's own output, and the one thing a percentage and a bar both quietly imply is
 *   that it is a probability of being correct. It is not, and the vocabulary used here is chosen so
 *   that nothing in the rendered output says it is.
 */

/**
 * Formats a score as a percentage for display.
 *
 * One decimal place, which is enough to separate a close first and second place — the single most
 * informative comparison in a ranking — without implying precision the model does not have. The
 * full-precision value remains available in the structured view, so nothing is lost by rounding
 * here.
 *
 * @param score Score between 0 and 1, as the model reported it.
 * @returns A string such as `"93.2%"`.
 */
export function formatScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

/**
 * Converts a score into a bar width percentage.
 *
 * Clamped to 0–100 so a score outside the expected range can never paint a bar outside its track.
 * The Worker already rejects such a score, and this is the second of the two places that would have
 * to fail for a malformed value to be rendered.
 *
 * @param score Score between 0 and 1.
 * @returns A width percentage between 0 and 100.
 */
export function barWidthPercent(score: number): number {
  return Math.min(100, Math.max(0, score * 100));
}

/**
 * Builds the sentence describing how much of the model's output is on screen.
 *
 * Phrased as "showing N of the M labels this model returned" rather than "top N", because the model
 * was not asked for N. It scored everything it scores and this application kept some; saying so is
 * the difference between describing the panel's behaviour and misdescribing the model's.
 *
 * @param shown How many labels are rendered.
 * @param total How many usable labels the model returned.
 * @returns A sentence for the result heading, or an empty string when nothing was returned.
 */
export function describeVisibleLabels(shown: number, total: number): string {
  if (total === 0) {
    return '';
  }

  if (shown === total) {
    return `Showing all ${total} ${total === 1 ? 'label' : 'labels'} this model returned.`;
  }

  return `Showing ${shown} of the ${total} labels this model returned.`;
}
