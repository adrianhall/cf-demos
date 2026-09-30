/**
 * @file Reading a scalar out of a record whose fields are typed `unknown`. Entity records arrive
 *   from GraphQL as an index signature — the components are descriptor-driven and look up
 *   `entity[attribute.field]`, so a precise per-type interface would be narrowed away at exactly
 *   the point of use. The consequence is that every field read is `unknown`, and an unrestricted
 *   `String(value)` would happily render a relation object as `[object Object]`. That is not a
 *   hypothetical: relations live in the same record as the scalars, so a descriptor naming
 *   `homeworld` where it meant `homeworldName` would produce a plausible-looking but useless label
 *   rather than an obvious failure. Treating only real strings and numbers as displayable turns
 *   that mistake into visibly empty text, which shows up in review and in test.
 */

/**
 * Read a field known to be a displayed scalar as text.
 *
 * @param value Field value from a GraphQL record.
 * @param fallback Text to use when the field is absent or is not a scalar; defaults to an empty
 *   string.
 * @returns The scalar as text, or the fallback. Numbers are stringified because the API's
 *   numeric-looking fields are already strings, so a real number here means a schema change rather
 *   than something to reject.
 */
export function scalarText(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}
