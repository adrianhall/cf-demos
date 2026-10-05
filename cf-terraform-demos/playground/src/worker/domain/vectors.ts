/**
 * @file Vector arithmetic for Semantic Search. This is the one panel whose _result_ is computed
 *   here rather than returned by a model: a bi-encoder hands back two lists of numbers, and the
 *   ranking a visitor sees is produced by the code in this file. That makes it domain logic in the
 *   strictest sense, and it is why the maths lives here with its own tests rather than inline in a
 *   service. Two decisions are worth stating. **Cosine similarity is the only metric offered**, and
 *   that is honesty rather than laziness: every reviewed model returns unit vectors, and for unit
 *   vectors cosine similarity, dot product, and Euclidean distance all induce the _same ranking_. A
 *   metric selector would therefore be a control that visibly does nothing, which teaches worse
 *   than no control at all. **A zero vector yields a similarity of zero rather than `NaN`.** The
 *   textbook formula divides by the product of the magnitudes, which is zero in that case;
 *   propagating `NaN` into a ranking would sort unpredictably and render as an empty bar rather
 *   than as the "no information" it actually represents.
 */

/**
 * Computes the Euclidean magnitude of a vector.
 *
 * @param vector The vector to measure.
 * @returns The magnitude, which is `0` for an empty or all-zero vector.
 */
export function vectorNorm(vector: readonly number[]): number {
  let total = 0;
  for (const component of vector) {
    total += component * component;
  }
  return Math.sqrt(total);
}

/**
 * Computes the cosine similarity of two vectors.
 *
 * Cosine similarity measures the angle between two vectors and ignores their magnitudes, which is
 * what makes it the conventional choice for embeddings: a longer passage can produce a
 * larger-magnitude vector without being any more or less relevant, and an angle is unaffected by
 * that.
 *
 * @param left First vector.
 * @param right Second vector, which must have the same number of components as `left`.
 * @returns The similarity, normally between -1 and 1. Returns `0` when either vector has zero
 *   magnitude, because an undirected vector is equally unlike everything rather than undefined.
 * @throws {Error} When the vectors have different lengths. That is a programming error rather than
 *   a data condition — two vectors from the same model always agree — so it throws rather than
 *   returning a score that would silently compare unrelated dimensions.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(
      `cannot compare vectors of different dimensions: ${left.length} and ${right.length}`
    );
  }

  let dot = 0;
  let leftSquares = 0;
  let rightSquares = 0;

  // One pass rather than three. The vectors are up to 2,048 components and this runs once per
  // passage per search, so the arithmetic is worth keeping tight even though it is not a
  // bottleneck.
  for (const [index, component] of left.entries()) {
    const other = right[index] ?? 0;
    dot += component * other;
    leftSquares += component * component;
    rightSquares += other * other;
  }

  const magnitude = Math.sqrt(leftSquares) * Math.sqrt(rightSquares);

  // Zero rather than `NaN`. A zero vector carries no direction, so it is equally unlike
  // everything; `NaN` would sort unpredictably and render as an empty bar, which reads as "least
  // relevant" rather than as "no information".
  return magnitude === 0 ? 0 : dot / magnitude;
}
