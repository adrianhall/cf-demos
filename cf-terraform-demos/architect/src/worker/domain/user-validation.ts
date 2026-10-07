import { unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';
import type { DirectoryPage } from './user.ts';

/**
 * @file Pagination validation for the administrative user directory. Pure, like every other module
 *   in this tier, so the HTTP API today and the MCP tool layer in a later phase bound the same read
 *   in the same way rather than each inventing its own ceiling.
 */

/**
 * Rows returned when the caller names no `limit`.
 *
 * Matches the page size the administrative table requests, so the default and the UI agree: a
 * client that omits the parameter gets the same page the one that sends it does.
 */
const DEFAULT_LIMIT = 20;

/**
 * Largest `limit` this API accepts.
 *
 * A ceiling rather than a preference. The directory read joins a correlated diagram count per row,
 * so an unbounded `limit` would let one request ask for an arbitrarily expensive scan of the whole
 * `diagrams` table — and the administrator is the one identity nothing else rate-limits.
 */
const MAX_LIMIT = 100;

/**
 * Parses a non-negative integer query parameter.
 *
 * Matched against a digits-only pattern rather than handed to `Number.parseInt`, which accepts
 * `12abc` and ` 7 ` and silently discards the rest. A caller who sent one of those meant something
 * this API cannot honour, and reporting it is more useful than guessing.
 *
 * @param value Raw query-string value, or `undefined` when the parameter was omitted.
 * @param name Parameter name, used only to write the refusal.
 * @returns The parsed integer, or `undefined` when `value` was omitted.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the value is present but is not
 *   a non-negative integer.
 */
function parseNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/u.test(value)) {
    throw unprocessableContent({ detail: `${name} must be a non-negative integer.` });
  }
  return Number.parseInt(value, 10);
}

/**
 * Validates the `limit` and `offset` query parameters of the administrative directory read.
 *
 * An out-of-range `limit` is refused rather than clamped. Clamping would answer a request for 500
 * rows with 100 and no indication that it had done so, which a paginating client would read as
 * "that was the last page".
 *
 * @param query Raw query-string values, straight from the request.
 * @returns The validated window, defaulted when a parameter was omitted.
 * @throws {ProblemDetailsError} `unprocessableContent()` (422) when either parameter is present but
 *   malformed, or when `limit` is zero or above {@link MAX_LIMIT}.
 */
export function validateDirectoryPage(query: { limit?: string; offset?: string }): DirectoryPage {
  const limit = parseNonNegativeInteger(query.limit, 'limit') ?? DEFAULT_LIMIT;
  const offset = parseNonNegativeInteger(query.offset, 'offset') ?? 0;

  if (limit === 0 || limit > MAX_LIMIT) {
    throw unprocessableContent({ detail: `limit must be between 1 and ${MAX_LIMIT}.` });
  }

  return { limit, offset };
}
