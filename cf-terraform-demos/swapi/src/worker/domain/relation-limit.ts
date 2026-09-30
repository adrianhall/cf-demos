import { GraphQLError } from 'graphql';

/**
 * Largest per-parent child list a caller may request from one relation field.
 *
 * This bounds the `first` argument, not the total response: a query selecting a relation on many
 * parents can still return more rows in total. Total query cost is bounded separately by the
 * complexity limits in `src/worker/application/graphql/builder.ts`.
 */
export const MAX_RELATION_LIMIT = 100;

/**
 * Validate the optional per-parent limit supplied to a relation field.
 *
 * This lives in the domain tier rather than beside the GraphQL field definitions so that every
 * caller of the application service enforces the same bound. The GraphQL schema's `Int` type only
 * guarantees an integer; it would happily accept `0`, `-5`, or `2_000_000_000`, each of which is
 * either meaningless or an invitation to build an expensive query.
 *
 * A rejected value raises rather than being clamped to the nearest legal value. Silently returning
 * 100 rows for `first: 5000` would misreport what the API did, and a caller paginating on that
 * assumption would never discover the limit.
 *
 * @param first Value of the field's `first` argument: absent, `null`, or an integer.
 * @returns `undefined` when no limit was requested, so the caller can omit the limiting clause
 *   entirely; otherwise the validated positive limit.
 * @throws {GraphQLError} When a limit is present but below `1` or above {@link MAX_RELATION_LIMIT},
 *   or is not an integer. A `GraphQLError` (rather than an RFC 9457 problem document) is correct
 *   here because the fault is in one field of an otherwise valid GraphQL document: it belongs in
 *   the response's `errors` array, located at that field's path, alongside any data the rest of the
 *   query successfully produced.
 */
export function validateRelationLimit(first: number | null | undefined): number | undefined {
  if (first === null || first === undefined) {
    return undefined;
  }

  if (!Number.isInteger(first) || first < 1 || first > MAX_RELATION_LIMIT) {
    throw new GraphQLError(`first must be an integer between 1 and ${MAX_RELATION_LIMIT}.`);
  }

  return first;
}
