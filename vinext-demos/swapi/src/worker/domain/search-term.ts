import { GraphQLError } from 'graphql';

/**
 * Longest search term a caller may supply to a collection field.
 *
 * The bound is not about protecting the database — a long `LIKE` pattern is no more expensive than
 * a short one against 260 rows. It is about keeping the API's inputs describable: a search term is
 * a thing a person typed into a box, and nothing a person types to find "Luke Skywalker" is 5,000
 * characters long. Accepting unbounded text would mean accepting request bodies whose size has no
 * relationship to any legitimate use, and would put that text into query logs and error messages.
 *
 * 100 is comfortably longer than the longest entity name in the dataset, so no legitimate search
 * can reach it.
 */
export const MAX_SEARCH_TERM_LENGTH = 100;

/**
 * Validate and normalise the optional search term supplied to a collection field.
 *
 * This lives in the domain tier alongside `validateRelationLimit` (see `./relation-limit.ts`) and
 * for the same reason: every transport that reaches a collection must enforce identical rules, so
 * the rule cannot live beside the GraphQL field definitions. The GraphQL `String` type guarantees
 * only that the value is text; it would happily accept an empty string or a megabyte of it.
 *
 * Two normalisations happen here, and both are deliberate rather than incidental:
 *
 * - **Surrounding whitespace is trimmed.** A trailing space is almost always an artefact of typing or
 *   of a copy-paste, never an intentional part of what the user is looking for.
 * - **A term that is empty once trimmed means "no filter".** The alternative — matching everything
 *   with `LIKE '%%'` — would produce the same rows but at the cost of a pointless scan, and it
 *   would make `search: ""` and `search: null` two spellings of one idea that took different code
 *   paths. Returning `undefined` collapses them, so the caller can omit the `WHERE` clause
 *   entirely.
 *
 * An over-long term is rejected rather than truncated. Silently searching for the first 100
 * characters of a longer term would return results that do not match what was asked for, and the
 * caller would have no way to tell that had happened — the same reasoning that makes
 * `validateRelationLimit` refuse to clamp.
 *
 * Note what this function deliberately does **not** do: it does not escape, quote, or otherwise
 * prepare the term for SQL. Wildcard escaping is a property of the `LIKE` operator, which is a
 * storage-tier concept, and it is handled in `../infrastructure/queries/sql.ts` where the term is
 * bound as a parameter. Splitting it that way keeps the domain rule free of SQL dialect and keeps
 * the injection-relevant handling in one reviewable place.
 *
 * @param search Value of the field's `search` argument: absent, `null`, or arbitrary text.
 * @returns `undefined` when no filter was requested or the term was blank, so the caller can omit
 *   the filter entirely; otherwise the trimmed term, ready to be bound as a parameter.
 * @throws {GraphQLError} When the trimmed term is longer than {@link MAX_SEARCH_TERM_LENGTH}. A
 *   `GraphQLError` rather than an RFC 9457 problem document, because the fault is in one argument
 *   of an otherwise valid document: it belongs in the response's `errors` array at that field's
 *   path, alongside whatever data the rest of the query produced successfully.
 */
export function validateSearchTerm(search: string | null | undefined): string | undefined {
  if (search === null || search === undefined) {
    return undefined;
  }

  const trimmed = search.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.length > MAX_SEARCH_TERM_LENGTH) {
    throw new GraphQLError(
      `search must be ${MAX_SEARCH_TERM_LENGTH} characters or fewer; received ${trimmed.length}.`
    );
  }

  return trimmed;
}
