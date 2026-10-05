/**
 * @file In-memory implementation of {@link EmbeddingCachePort}. As with the run repository,
 *   in-memory is a deliberate design choice rather than a stopgap — but the reasoning is different
 *   and worth setting out, because here a persistent cache would be genuinely _useful_ and is still
 *   the wrong call for this demo. The panel's lesson is that an embedding is computed once and
 *   reused. An isolate-scoped cache demonstrates that completely: search twice and the second
 *   search is visibly free. What a KV or D1 cache would add is durability across isolates, which
 *   costs a storage product, a Terraform resource, a teardown step, a retention policy, and a
 *   privacy question this demo would then owe an answer to — because unlike a run record, a cache
 *   key is derived from the visitor's own text. The spec is explicit that cache scope is the
 *   current session until a storage design is separately specified, and this honours that. **Only
 *   vectors are stored, never text.** The key is a hash of the text rather than the text itself, so
 *   the cache holds no copy of anything a visitor typed. That is not merely tidy: it means the one
 *   place in this panel that retains anything between requests cannot leak the content it was
 *   derived from, even to someone holding a memory dump of the isolate. The map is module-scoped
 *   rather than per-instance so a vector survives being written by one request and read by the next
 *   within the same isolate — which is the entire point of storing it.
 */

import type { EmbeddingCachePort } from '../../application/ports/embedding-cache-port';

/**
 * Most vectors kept at once.
 *
 * A bound rather than a preference. A 2,048-dimension vector is roughly 16 KB as JavaScript
 * numbers, so an unbounded cache in a long-lived isolate serving a busy demo would grow without
 * limit. Eviction is oldest-first, which approximates least-recently-added and is the right shape
 * for a demo where a visitor works through one collection at a time.
 */
export const MAX_CACHED_EMBEDDINGS = 400;

/**
 * Cached vectors for the current isolate, keyed by an opaque verified-identity scope, model
 * identifier, and text hash.
 *
 * **No sharing across visitors.** A passage vector is derived from visitor content, and a cache hit
 * would reveal that some _other_ person submitted byte-identical content even if neither the text
 * nor the vector were displayed. The service supplies `actor.sub` as the scope, so a cache is a
 * current-session optimisation for one verified identity rather than an accidental shared corpus.
 *
 * A `Map` preserves insertion order, which is what makes oldest-first eviction a single `keys()`
 * walk rather than a sort by timestamp.
 */
const vectors = new Map<string, readonly number[]>();

/**
 * Derives the cache key for one text under one model.
 *
 * **Content-derived, and deliberately not the content.** A 64-bit FNV-1a hash of the text is enough
 * to distinguish the passages in a collection while storing nothing a visitor typed. The model
 * identifier is part of the key because a vector belongs to the model that produced it: the same
 * sentence under a 768-dimension model and a 1,024-dimension one gives two different answers, and
 * returning one for the other would corrupt a ranking undetectably.
 *
 * A non-cryptographic hash is the right tool here. The threat a cache key faces is accidental
 * collision between two passages in one small collection, not an adversary engineering one — and a
 * collision would at worst reuse the wrong vector within a single visitor's own session. The length
 * is mixed in as well, so two texts must agree on both hash and length to collide.
 *
 * @param scope Opaque verified-identity scope. Included before the model and text hash so no cache
 *   entry is shared between visitors.
 * @param modelId Identifier of the model that produced or would produce the vector.
 * @param text The text being embedded.
 * @returns An opaque key containing no fragment of the text.
 */
export function embeddingCacheKey(scope: string, modelId: string, text: string): string {
  // FNV-1a over UTF-16 code units, carried in two 16-bit halves so the arithmetic stays inside
  // the exact-integer range rather than silently losing precision in a double.
  let high = 0x811c;
  let low = 0x9dc5;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high ^= (code >>> 8) & 0xff;
    low ^= code & 0xff;

    const nextLow = low * 403;
    const nextHigh = high * 403 + ((low * 403) >>> 16);
    low = nextLow & 0xffff;
    high = nextHigh & 0xffff;
  }

  const hash = ((high << 16) >>> 0) + low;
  return `${scope}\u0000${modelId}\u0000${hash.toString(36)}\u0000${text.length}`;
}

/**
 * Discards every cached vector.
 *
 * Exported for tests: the store is module-scoped so it would otherwise leak between test cases, and
 * a suite that depended on the leak would pass for the wrong reason — a cache-miss test would see a
 * hit left behind by whichever test happened to run first.
 *
 * @returns Nothing; the cache is empty.
 */
export function clearEmbeddingCache(): void {
  vectors.clear();
}

/**
 * Creates an embedding cache backed by the isolate's memory.
 *
 * @returns An {@link EmbeddingCachePort} over the module-scoped store.
 */
export function createMemoryEmbeddingCache(): EmbeddingCachePort {
  return {
    /**
     * Reads a cached vector.
     *
     * @param scope Opaque verified-identity scope; entries from another visitor are never read.
     * @param modelId Identifier of the model that would produce the vector.
     * @param text The exact text whose embedding is wanted.
     * @returns The cached vector, or `undefined` on a miss.
     */
    async get(
      scope: string,
      modelId: string,
      text: string
    ): Promise<readonly number[] | undefined> {
      return vectors.get(embeddingCacheKey(scope, modelId, text));
    },

    /**
     * Stores a vector, evicting the oldest entries once the bound is reached.
     *
     * @param scope Opaque verified-identity scope; entries from another visitor are never reused.
     * @param modelId Identifier of the model that produced the vector.
     * @param text The exact text that was embedded.
     * @param vector The embedding to remember.
     * @returns A promise fulfilled once the vector is retrievable.
     */
    async set(
      scope: string,
      modelId: string,
      text: string,
      vector: readonly number[]
    ): Promise<void> {
      vectors.set(embeddingCacheKey(scope, modelId, text), vector);

      // Evicted after insertion rather than before, so the size bound holds for the store as it
      // now stands. Evicting first would let the store settle one entry above its own limit.
      while (vectors.size > MAX_CACHED_EMBEDDINGS) {
        const oldest = vectors.keys().next();
        if (oldest.done === true) {
          break;
        }
        vectors.delete(oldest.value);
      }
    }
  };
}
