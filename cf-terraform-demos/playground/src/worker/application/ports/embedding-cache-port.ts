/**
 * @file The port through which Semantic Search reuses an embedding it has already paid for. This is
 *   the first port in the demo that exists for a _cost_ reason rather than a capability one:
 *   nothing about the panel stops working without it, but every repeat search would be charged
 *   again for vectors that cannot have changed. Caching is sound here for a reason that is worth
 *   stating rather than assuming, and it was verified against each live model rather than taken on
 *   trust: these embedding models are **deterministic**. The same text embedded twice by
 *   `@cf/baai/bge-m3`, `@cf/qwen/qwen3-embedding-0.6b`, and `@cf/google/embeddinggemma-300m`
 *   returns bit-identical vectors. A cached vector is therefore the same answer the model would
 *   give, not an approximation of it. A cross-encoder is deliberately **not** cacheable through
 *   this port. Its score describes a query/passage _pair_ rather than a passage, so a new query
 *   invalidates every score it has ever produced; the reviewed descriptor declares that with
 *   `cacheable: false` and the service never consults the cache for it. See
 *   `src/shared/semantic-search.ts`.
 */

/**
 * A store of embeddings already computed, keyed by model and text.
 *
 * Keyed by both because a vector belongs to the model that produced it: the same sentence embedded
 * by a 768-dimension model and a 1,024-dimension one gives two different, non-interchangeable
 * answers. A cache keyed by text alone would return the wrong model's vector and produce a ranking
 * that is wrong in a way nothing downstream could detect.
 */
export interface EmbeddingCachePort {
  /**
   * Reads a cached vector.
   *
   * @param scope An opaque verified-identity scope. Embeddings are never shared between visitors:
   *   the cache is an optimisation for one person's current application session, not a corpus built
   *   from everyone who happened to use the demo.
   * @param modelId Identifier of the model that would produce the vector.
   * @param text The exact text whose embedding is wanted.
   * @returns The cached vector, or `undefined` when this text has not been embedded by this model.
   */
  get(scope: string, modelId: string, text: string): Promise<readonly number[] | undefined>;

  /**
   * Stores a vector for later reuse.
   *
   * @param scope An opaque verified-identity scope; see {@link EmbeddingCachePort.get}.
   * @param modelId Identifier of the model that produced the vector.
   * @param text The exact text that was embedded.
   * @param vector The embedding to remember.
   * @returns A promise fulfilled once the vector is retrievable.
   */
  set(scope: string, modelId: string, text: string, vector: readonly number[]): Promise<void>;
}
