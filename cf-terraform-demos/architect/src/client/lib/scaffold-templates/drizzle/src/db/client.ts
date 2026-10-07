import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Builds a typed Drizzle client over a D1 binding.
 *
 * ```ts
 * const db = createDb(env.MY_DATABASE);
 * const rows = await db.select().from(schema.examples).all();
 * ```
 *
 * @param d1 D1 binding, as declared in `cloudflare.config.ts` and exposed on `env`.
 * @returns A Drizzle client bound to {@link schema}.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
