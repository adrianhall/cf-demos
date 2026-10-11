/**
 * @file Identifier rules shared by the browser, the Application Worker, and the Data Worker. Every
 *   entity identifier is a lowercase UUID produced by `crypto.randomUUID()` (specification §2.10).
 *   Upper-case input is rejected rather than normalised so that one record can never be addressed
 *   by two spellings, which would otherwise defeat idempotency hashing and cache keys.
 */

import * as v from 'valibot';

/**
 * Lowercase RFC 9562 UUID text, as produced by `crypto.randomUUID()`.
 */
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Schema for an entity identifier.
 */
export const IdSchema = v.pipe(v.string(), v.regex(LOWERCASE_UUID, 'Must be a lowercase UUID.'));

/**
 * An entity identifier.
 */
export type Id = v.InferOutput<typeof IdSchema>;
