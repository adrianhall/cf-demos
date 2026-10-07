/**
 * @file A recording Workers KV test double, the counterpart to `./fake-d1.ts` for the share
 *   adapter's second store. Unlike the D1 double, this one really stores values: the adapter's
 *   interesting behaviour is the _relationship_ between the two stores — a lookup entry written on
 *   create, deleted on revoke, and backfilled after a miss — which a double that only recorded
 *   calls could not express.
 */

/**
 * A fake KV namespace together with the entries it currently holds.
 */
export interface FakeKv {
  /**
   * The object to pass to an adapter's constructor, narrowed to the capabilities the adapter uses.
   */
  kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
  /**
   * Entries currently stored, which a test inspects after exercising the adapter.
   */
  entries: Map<string, string>;
}

/**
 * Creates an in-memory KV double.
 *
 * @param initial Entries the namespace starts with, keyed by token digest. Omitted for the common
 *   case of an empty namespace, which is also what a cold cache or an evicted key looks like.
 * @returns The double and the live map backing it.
 */
export function createFakeKv(initial: Record<string, string> = {}): FakeKv {
  const entries = new Map<string, string>(Object.entries(initial));

  return {
    entries,
    kv: {
      /**
       * Reads a value.
       *
       * @param key Key to read.
       * @returns The stored value, or `null` when the key is absent — which is also how a real KV
       *   namespace reports a key that has not yet propagated to the reading location.
       */
      async get(key: string) {
        return entries.get(key) ?? null;
      },

      /**
       * Writes a value.
       *
       * @param key Key to write.
       * @param value Value to store.
       * @returns A promise fulfilled once the entry is stored.
       */
      async put(key: string, value: string) {
        entries.set(key, value);
      },

      /**
       * Deletes a value.
       *
       * @param key Key to delete.
       * @returns A promise fulfilled once the entry is gone. Deleting an absent key is a no-op, as
       *   it is in real KV.
       */
      async delete(key: string) {
        entries.delete(key);
      }
    } as Pick<KVNamespace, 'get' | 'put' | 'delete'>
  };
}
