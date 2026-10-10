/** Validates the explicit per-parent limit for batched relationship fields. */
import { GraphQLError } from "graphql";

/** Largest child list a caller may request from one relationship field. */
export const MAX_RELATION_FIRST = 100;

/**
 * Validates a relation's optional per-parent result limit.
 *
 * @param first - GraphQL argument supplied to a relationship field.
 * @returns An absent limit or a positive limit within the supported range.
 * @throws GraphQLError When the requested limit is outside the supported range.
 */
export function relationFirst(
  first: number | null | undefined,
): number | undefined {
  if (first === null || first === undefined) {
    return undefined;
  }

  if (first < 1 || first > MAX_RELATION_FIRST) {
    throw new GraphQLError(`first must be between 1 and ${MAX_RELATION_FIRST}`);
  }

  return first;
}
