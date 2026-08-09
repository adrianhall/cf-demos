import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * Create a typed Drizzle client from the D1 binding.
 *
 * Usage in a Worker:
 * ```ts
 * const db = createDb(env.DB);
 * const rows = await db.select().from(schema.examples).all();
 * ```
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
