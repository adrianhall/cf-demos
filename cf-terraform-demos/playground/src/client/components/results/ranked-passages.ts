/**
 * @file Pure presentation helpers for a ranked search result. Plain functions over plain data: no
 *   Vue, no fetch, no DOM. These are deliberately **not** the ranked-label helpers next door, even
 *   though both render a number against a row, and the reason is the vocabulary rather than the
 *   layout. A classifier's score is the model's own estimate for a fixed label and reads naturally
 *   as a percentage. A similarity is not that at all: it is a position _relative to the other
 *   passages in this collection, under this model_. Formatting it as "73.3%" would invite exactly
 *   the reading the panel exists to prevent — that the passage is 73% likely to be the right
 *   answer, or that 73% under one model means what it means under another. So a similarity is shown
 *   to three decimal places as a bare number, which looks like a coordinate rather than a
 *   probability. The second difference is the bar. A classifier's scores spread across the range; a
 *   cross-encoder's collapse onto a floor around 0.00004 for everything irrelevant, so a
 *   proportional bar renders every non-match as an identical empty track. That is not a rendering
 *   bug to be fixed by rescaling — the model really did separate them that emphatically — so the
 *   bar stays proportional and {@link describeScoreScale} explains the collapse in words.
 */

import type { RetrievalStrategy } from '../../../shared/semantic-search';

/**
 * Formats a relevance score for display.
 *
 * Three decimal places and no percent sign. A similarity is a position in a vector space rather
 * than a proportion of anything, and a percentage would imply a confidence the number does not
 * carry. Three places is also what the reranker needs to stay readable: two would round every
 * irrelevant passage to a bare `0.000` and hide that it scored them at all.
 *
 * @param score The score as the model or the similarity computation produced it.
 * @returns A string such as `"0.733"`.
 */
export function formatSimilarity(score: number): string {
  return score.toFixed(3);
}

/**
 * Converts a score into a bar width percentage.
 *
 * Clamped to 0–100 so a score outside the expected range can never paint a bar outside its track. A
 * negative cosine similarity is possible in principle and renders as an empty bar, which is the
 * honest depiction of "pointing the other way".
 *
 * @param score The score to depict.
 * @returns A width percentage between 0 and 100.
 */
export function similarityBarWidthPercent(score: number): number {
  return Math.min(100, Math.max(0, score * 100));
}

/**
 * Names the scale a set of scores lives on.
 *
 * The single most important sentence in the result area. Without it a visitor comparing two models
 * will read one number as better than another when the two are not on the same scale at all.
 *
 * @param strategy Which operation produced the scores.
 * @param dimensions The model's vector size, when it has one.
 * @param collapses Whether this model's irrelevant scores collapse onto a near-zero floor.
 * @returns A sentence describing what the numbers are and what they are not.
 */
export function describeScoreScale(
  strategy: RetrievalStrategy,
  dimensions: number | undefined,
  collapses: boolean
): string {
  if (strategy === 'cross-encoder') {
    const collapseNote = collapses
      ? ' This model separates sharply: an irrelevant passage typically scores around 0.00004 '
        + 'rather than merely low, so most bars are empty by a very large margin rather than by a '
        + 'small one.'
      : '';

    return (
      'These are relevance scores the model produced by reading the query and each passage '
      + `together. They are not probabilities, and they cannot be compared with the similarity `
      + `scores from an embedding model.${collapseNote}`
    );
  }

  const space =
    dimensions === undefined ? 'this model\u2019s vector space' : `${dimensions} dimensions`;

  return (
    `These are cosine similarities between the query\u2019s vector and each passage\u2019s, in `
    + `${space}. A similarity is a relative position, not a probability and not a measure of `
    + 'correctness \u2014 and a score from this model cannot be compared with one from a model of '
    + 'a different size.'
  );
}

/**
 * Builds the sentence describing how much of the ranking is on screen.
 *
 * Phrased as "showing N of the M passages ranked" rather than "top N", because for every embedding
 * model the model was not asked for N: it scored the whole collection and this application kept
 * some.
 *
 * @param shown How many results are rendered.
 * @param total How many passages were ranked.
 * @returns A sentence for the result heading, or an empty string when nothing was ranked.
 */
export function describeVisiblePassages(shown: number, total: number): string {
  if (total === 0) {
    return '';
  }

  if (shown === total) {
    return `Showing all ${total} ranked ${total === 1 ? 'passage' : 'passages'}.`;
  }

  return `Showing ${shown} of the ${total} passages ranked.`;
}

/**
 * Describes what one search actually cost in model calls.
 *
 * The panel's central claim made checkable. A repeat search over an unchanged collection reports no
 * calls at all, which is a stronger demonstration that embeddings are reusable than any amount of
 * explanation.
 *
 * @param inferenceCallCount How many gateway calls the search made.
 * @param embeddedPassageCount How many passages had to be embedded.
 * @param cachedPassageCount How many passages were reused from the cache.
 * @param queryEmbedded Whether the query itself had to be embedded.
 * @returns A sentence describing the cost of the search.
 */
export function describeSearchCost(
  inferenceCallCount: number,
  embeddedPassageCount: number,
  cachedPassageCount: number,
  queryEmbedded: boolean
): string {
  if (inferenceCallCount === 0) {
    return (
      'This search made no model calls at all. The query and every passage had already been '
      + 'embedded, so the ranking was computed from stored vectors and cost nothing.'
    );
  }

  const parts: string[] = [];

  if (queryEmbedded) {
    parts.push('the query');
  }

  if (embeddedPassageCount > 0) {
    parts.push(`${embeddedPassageCount} ${embeddedPassageCount === 1 ? 'passage' : 'passages'}`);
  }

  const embedded = parts.length === 0 ? 'nothing new' : parts.join(' and ');

  const reused =
    cachedPassageCount > 0
      ? ` ${cachedPassageCount} ${cachedPassageCount === 1 ? 'passage was' : 'passages were'} `
        + 'reused from an earlier search and cost nothing.'
      : '';

  return (
    `This search made ${inferenceCallCount} `
    + `${inferenceCallCount === 1 ? 'model call' : 'model calls'}, embedding ${embedded}.${reused}`
  );
}
