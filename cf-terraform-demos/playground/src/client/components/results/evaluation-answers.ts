/**
 * @file Pure presentation helpers for typed evaluation answers. Plain functions over plain data: no
 *   Vue, no fetch, no DOM. These are deliberately **not** the ranked-label or ranked-passage
 *   helpers next door, and the reason is that this panel renders two different kinds of number that
 *   must never be confused. A **probability** is the model's answer — how likely this option is. A
 *   **confidence** is how sure the model is about that answer. They are independent: verified live,
 *   the same routing question answered `ENGINEERING` at probability `0.9831` with confidence
 *   `0.9334` for a clear state, and at probability `0.7111` with confidence `0.1782` for the state
 *   `"Hello"`. The second looks decisive and is the model saying it is guessing. A single formatter
 *   shared with the other panels would quietly invite a single visual treatment, and the whole
 *   point here is that these two numbers get different ones.
 */

/**
 * Formats a probability for display.
 *
 * A percentage with one decimal place. Unlike a similarity score, this genuinely _is_ a probability
 * — the model's calibrated likelihood over a closed set of answers that sums to one — so a
 * percentage is the honest rendering rather than an overstatement.
 *
 * @param probability Value between 0 and 1.
 * @returns A string such as `"93.5%"`.
 */
export function formatProbability(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/**
 * Converts a probability into a bar width percentage.
 *
 * Clamped to 0–100 so a value outside the expected range can never paint a bar outside its track.
 *
 * @param probability Value between 0 and 1.
 * @returns A width percentage between 0 and 100.
 */
export function probabilityBarWidthPercent(probability: number): number {
  return Math.min(100, Math.max(0, probability * 100));
}

/**
 * Describes what a `noul` probability means, in words.
 *
 * Words as well as a number, because the single most likely misreading of this panel is that a
 * probability is a verdict. A `0.52` rendered only as a bar looks like a slightly-short bar; said
 * aloud as "barely leaning towards yes" it is obviously not a decision anyone should act on
 * unreviewed.
 *
 * The bands are deliberately coarse. A finer scale would imply the wording carries information the
 * number does not already have.
 *
 * @param probability Value between 0 and 1.
 * @returns A short phrase describing the strength of the judgement.
 */
export function describeNoulStrength(probability: number): string {
  if (probability >= 0.9) {
    return 'Strongly yes';
  }
  if (probability >= 0.65) {
    return 'Leaning yes';
  }
  if (probability > 0.35) {
    return 'Genuinely uncertain';
  }
  if (probability > 0.1) {
    return 'Leaning no';
  }
  return 'Strongly no';
}

/**
 * Describes how much weight to put on an answer, from its confidence.
 *
 * Separate from {@link describeNoulStrength} because it describes a different axis. A low confidence
 * does not mean "no" — it means the model would not be surprised to be wrong, whichever way the
 * answer went.
 *
 * @param confidence Value between 0 and 1.
 * @returns A short phrase describing how settled the answer is.
 */
export function describeConfidence(confidence: number): string {
  if (confidence >= 0.8) {
    return 'Very confident';
  }
  if (confidence >= 0.5) {
    return 'Moderately confident';
  }
  if (confidence >= 0.25) {
    return 'Low confidence';
  }
  return 'Very low confidence \u2014 treat this as a guess';
}

/**
 * Positions a continuous score along its legend, as a percentage of the axis.
 *
 * The score is a position on a zero-based legend, so a `3.51` on a five-entry legend sits at `3.51
 * / 4` of the way along — the denominator is the number of _intervals_, not of entries. A
 * single-entry legend cannot occur (the model requires two) but is handled as the midpoint rather
 * than dividing by zero.
 *
 * @param score The continuous score the model returned.
 * @param legendLength How many entries the legend has.
 * @returns A position between 0 and 100.
 */
export function scorePositionPercent(score: number, legendLength: number): number {
  if (legendLength <= 1) {
    return 50;
  }
  const ratio = score / (legendLength - 1);
  return Math.min(100, Math.max(0, ratio * 100));
}

/**
 * Names the legend entries a continuous score falls between.
 *
 * The text alternative to the gauge, and the reason the gauge can be decoration. A score of `3.51`
 * on the support-triage legend reads as "between Angry and Furious and threatening to leave", which
 * is the whole finding without needing to see a marker on a line.
 *
 * @param score The continuous score.
 * @param legend The ordered legend, lowest first.
 * @returns A sentence describing where the score sits, or an empty string for an empty legend.
 */
export function describeScorePosition(score: number, legend: readonly string[]): string {
  if (legend.length === 0) {
    return '';
  }

  const lowerIndex = Math.max(0, Math.min(legend.length - 1, Math.floor(score)));
  const upperIndex = Math.max(0, Math.min(legend.length - 1, Math.ceil(score)));
  const lower = legend[lowerIndex];
  const upper = legend[upperIndex];

  if (lower === undefined || upper === undefined) {
    return '';
  }

  if (lowerIndex === upperIndex) {
    return `${score.toFixed(2)} on the legend \u2014 ${lower}.`;
  }

  return `${score.toFixed(2)} on the legend \u2014 between ${lower} and ${upper}.`;
}

/**
 * Describes what one evaluation cost, in the model's own terms.
 *
 * The asymmetric price shape made legible. Verified live on every call: the typed answer is not
 * generated text, so there is no output to bill. Stating the zero explicitly is what turns it from
 * a gap in a table into the point being made.
 *
 * @param inputTokens Input tokens the model reported reading.
 * @param outputTokens Output tokens the model reported producing.
 * @param questionCount How many questions were answered in this one call.
 * @returns A sentence describing the usage.
 */
export function describeEvaluationUsage(
  inputTokens: number,
  outputTokens: number,
  questionCount: number
): string {
  const batching =
    questionCount === 1
      ? 'one question'
      : `${questionCount} questions answered in a single model call`;

  if (outputTokens === 0) {
    return (
      `${inputTokens.toLocaleString()} input tokens and no output tokens, for ${batching}. A `
      + 'decision model is billed for what it reads: the answer is a typed structure rather than '
      + 'generated text, so there is no output to charge for.'
    );
  }

  return (
    `${inputTokens.toLocaleString()} input tokens and `
    + `${outputTokens.toLocaleString()} output tokens, for ${batching}.`
  );
}
