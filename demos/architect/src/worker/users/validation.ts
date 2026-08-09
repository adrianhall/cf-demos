import { unprocessableContent } from "@adrianhall/cloudflare-toolkit/errors";

/** Default number of directory rows returned per page when `limit` is omitted. */
const DEFAULT_LIMIT = 20;

/** Largest `limit` this API accepts, bounding worst-case D1 read cost per request. */
const MAX_LIMIT = 100;

/** Validated pagination parameters for `GET /api/admin/users`. */
export interface ListUsersQuery {
  /** Maximum number of rows to return. */
  limit: number;
  /** Number of rows to skip before the returned page. */
  offset: number;
}

/**
 * Parse and validate a non-negative integer query parameter.
 *
 * @param value Raw query string value, or `undefined` when the parameter was omitted.
 * @param name Parameter name, used only in error messages.
 * @returns The parsed integer, or `undefined` when `value` was omitted.
 * @throws {ProblemDetailsError} When `value` is present but not a non-negative integer.
 */
function parseNonNegativeInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw unprocessableContent({
      detail: `${name} must be a non-negative integer.`,
    });
  }
  return Number.parseInt(value, 10);
}

/**
 * Validate the `limit`/`offset` query parameters of `GET /api/admin/users`.
 *
 * @param query Raw query string values from `context.req.query()`.
 * @returns Validated pagination parameters, defaulted when omitted and clamped to
 * {@link MAX_LIMIT}.
 * @throws {ProblemDetailsError} When `limit` or `offset` is present but not a non-negative
 * integer.
 */
export function validateListUsersQuery(query: {
  limit?: string;
  offset?: string;
}): ListUsersQuery {
  const limit = parseNonNegativeInteger(query.limit, "limit") ?? DEFAULT_LIMIT;
  const offset = parseNonNegativeInteger(query.offset, "offset") ?? 0;

  if (limit === 0 || limit > MAX_LIMIT) {
    throw unprocessableContent({
      detail: `limit must be between 1 and ${MAX_LIMIT}.`,
    });
  }

  return { limit, offset };
}
