/**
 * @file Reads vectors and relevance scores out of untrusted provider responses, and turns them into
 *   the ranking the panel shows. Kept separate from validation for the same reason every other
 *   panel separates them: what a _caller_ may ask for and what a _provider_ is allowed to answer
 *   are different questions with different failure modes, and a module that mixed them would make a
 *   provider contract change look like a user error. The reviewed models return three different
 *   envelopes around the same idea, all verified with `cf ai run`. `@cf/baai/bge-m3` answers `{
 *   data, shape, pooling, meta, response }`; `@cf/qwen/qwen3-embedding-0.6b` answers `{ data,
 *   shape, usage }`; `@cf/google/embeddinggemma-300m` answers `{ data, shape }` alone. Only `data`
 *   is common to all three, so only `data` is read — an optional field that two models omit is not
 *   something to depend on. Every function here refuses rather than repairs. A response with the
 *   wrong number of vectors is not salvageable by taking the ones that arrived: the vectors are
 *   positional, so a short list would silently attribute each vector to the wrong passage and
 *   produce a ranking that looks entirely plausible and is entirely wrong.
 */

import type { RankedPassage, VectorSummary } from '../../shared/semantic-search';
import { VECTOR_PREVIEW_COMPONENTS } from '../../shared/semantic-search';
import { cosineSimilarity, vectorNorm } from './vectors';

/**
 * Why a provider response could not be used.
 *
 * Distinguished rather than collapsed into one failure, because the useful advice differs and so
 * does the diagnosis: a wrong vector count is a contract change, while a non-finite component is a
 * corrupt payload.
 */
export type EmbeddingRejection =
  /**
   * The response was not an object, or carried no `data` array at all.
   */
  | 'unrecognised_shape'
  /**
   * The response carried a different number of vectors than texts were submitted.
   */
  | 'wrong_cardinality'
  /**
   * A vector was empty, held a non-numeric component, or held a non-finite one.
   */
  | 'malformed_vector'
  /**
   * Two vectors from the same model had different dimensions, so they cannot be compared.
   */
  | 'inconsistent_dimensions';

/**
 * The result of reading embeddings from one provider response.
 */
export type ReadEmbeddingsOutcome =
  | { ok: true; vectors: number[][] }
  | { ok: false; reason: EmbeddingRejection };

/**
 * Why a reranker response could not be used.
 */
export type RerankerRejection =
  /**
   * The response was not an object, or carried no `response` array.
   */
  | 'unrecognised_shape'
  /**
   * An entry named a passage index outside the submitted collection.
   */
  | 'index_out_of_range'
  /**
   * No entry carried a usable index and score pair.
   */
  | 'no_usable_scores';

/**
 * The result of reading relevance scores from one cross-encoder response.
 */
export type ReadRerankerOutcome =
  | { ok: true; scores: { index: number; score: number }[] }
  | { ok: false; reason: RerankerRejection };

/**
 * Narrows a value to a plain object.
 *
 * @param value Untrusted value.
 * @returns The value as a record, or `undefined` when it is not a plain object.
 */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the vectors from one embedding response.
 *
 * Only `data` is read. The reviewed models disagree about every other field — `shape`, `pooling`,
 * `usage`, and `meta` each appear in some responses and not others — so depending on any of them
 * would make the reader work for one model and fail for the next.
 *
 * @param output The provider's raw output.
 * @param expectedCount How many texts were submitted, and therefore how many vectors must come
 *   back. Checked rather than trusted because the vectors are positional: a short list would
 *   attribute each vector to the wrong text.
 * @returns The vectors, or a refusal naming why the response was unusable; see
 *   {@link ReadEmbeddingsOutcome}.
 */
export function readEmbeddings(output: unknown, expectedCount: number): ReadEmbeddingsOutcome {
  const root = plainObject(output);
  const data = root?.['data'];

  if (!Array.isArray(data)) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  // Positional, so a mismatch is unsalvageable rather than partially usable. Taking the vectors
  // that did arrive would produce a confident ranking of the wrong passages.
  if (data.length !== expectedCount) {
    return { ok: false, reason: 'wrong_cardinality' };
  }

  const vectors: number[][] = [];

  for (const row of data) {
    if (!Array.isArray(row) || row.length === 0) {
      return { ok: false, reason: 'malformed_vector' };
    }

    const vector: number[] = [];
    for (const component of row) {
      // `Number.isFinite` rejects `NaN` and both infinities. One such component would propagate
      // through every similarity computed against this vector and corrupt the whole ranking.
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        return { ok: false, reason: 'malformed_vector' };
      }
      vector.push(component);
    }

    // Two vectors of different lengths cannot be compared at all, and the comparison would throw
    // deeper in. Caught here so it is reported as a provider contract failure rather than as an
    // unhandled error.
    const first = vectors[0];
    if (first !== undefined && vector.length !== first.length) {
      return { ok: false, reason: 'inconsistent_dimensions' };
    }

    vectors.push(vector);
  }

  return { ok: true, vectors };
}

/**
 * Reads the relevance scores from one cross-encoder response.
 *
 * The reranker answers `{ response: [{ id, score }] }`, where `id` is the index of the passage in
 * the submitted `contexts` array. Verified against the live model, which returns the entries
 * already sorted best-first — but this reader sorts anyway rather than relying on it, because an
 * ordering that is not in the schema is an implementation detail rather than a contract.
 *
 * @param output The provider's raw output.
 * @param passageCount How many passages were submitted, used to reject an out-of-range index.
 * @returns The scores with their passage indices, or a refusal; see {@link ReadRerankerOutcome}.
 */
export function readRerankerScores(output: unknown, passageCount: number): ReadRerankerOutcome {
  const root = plainObject(output);
  const entries = root?.['response'];

  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'unrecognised_shape' };
  }

  const scores: { index: number; score: number }[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    const record = plainObject(entry);
    if (record === undefined) {
      continue;
    }

    const index = record['id'];
    const score = record['score'];

    if (typeof index !== 'number' || !Number.isInteger(index)) {
      continue;
    }

    // An index outside the collection is refused rather than skipped. It means the model is
    // referring to a passage that was not submitted, and silently dropping it would leave a
    // ranking that looks complete while describing a different collection.
    if (index < 0 || index >= passageCount) {
      return { ok: false, reason: 'index_out_of_range' };
    }

    if (typeof score !== 'number' || !Number.isFinite(score)) {
      continue;
    }

    // A duplicate index would rank the same passage twice. The first is kept, because the model
    // returns its entries best-first.
    if (seen.has(index)) {
      continue;
    }

    seen.add(index);
    scores.push({ index, score });
  }

  if (scores.length === 0) {
    return { ok: false, reason: 'no_usable_scores' };
  }

  return { ok: true, scores };
}

/**
 * Ranks a collection against a query by cosine similarity.
 *
 * @param queryVector The query's embedding.
 * @param passageVectors One embedding per passage, in the collection's own order.
 * @param cachedFlags Whether each passage's embedding was reused rather than recomputed, in the
 *   same order.
 * @returns Every passage ranked best-first, before any result count is applied.
 * @throws {Error} When a passage vector has a different dimension than the query's, which
 *   {@link readEmbeddings} already rejects and which therefore indicates a programming error here.
 */
export function rankByCosineSimilarity(
  queryVector: readonly number[],
  passageVectors: readonly (readonly number[])[],
  cachedFlags: readonly boolean[]
): RankedPassage[] {
  const scored = passageVectors.map((vector, index) => ({
    index,
    score: cosineSimilarity(queryVector, vector),
    cached: cachedFlags[index] ?? false
  }));

  return assignRanks(scored);
}

/**
 * Sorts scored passages best-first and assigns their ordinals.
 *
 * Ties are broken by the passage's position in the submitted collection, so an identical pair of
 * passages ranks deterministically. Without that, two equal scores could swap places between
 * otherwise identical searches and make the panel look unstable.
 *
 * @param scored One entry per passage, with its score and cache state.
 * @returns The same entries sorted best-first, each carrying its rank.
 */
export function assignRanks(
  scored: readonly { index: number; score: number; cached: boolean }[]
): RankedPassage[] {
  return [...scored]
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry, position) => ({
      rank: position + 1,
      index: entry.index,
      score: entry.score,
      cached: entry.cached
    }));
}

/**
 * Builds the limited disclosure shown for one embedding.
 *
 * @param vector The vector to summarise.
 * @returns Its dimension count, first few components, and magnitude; see {@link VectorSummary}.
 */
export function summariseVector(vector: readonly number[]): VectorSummary {
  return {
    dimensions: vector.length,
    preview: vector.slice(0, VECTOR_PREVIEW_COMPONENTS),
    norm: vectorNorm(vector)
  };
}
