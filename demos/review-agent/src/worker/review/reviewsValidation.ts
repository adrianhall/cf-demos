import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";
import { z } from "zod";

/** Default page size for `GET /api/reviews` when the caller omits `?pageSize=`. */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size `GET /api/reviews` accepts, regardless of what a caller requests -- a
 * simple abuse/cost control against a single request trying to read the entire run history in
 * one page. */
export const MAX_PAGE_SIZE = 100;

const ManualTriggerBodySchema = z.object({
  url: z.string().trim().min(1, "url is required"),
});

/** A validated `POST /api/reviews` request body. */
export interface ManualTriggerBody {
  readonly url: string;
}

/**
 * Validate `POST /api/reviews`'s request body -- only that `url` is present and non-empty.
 * Whether `url` actually matches a GitHub PR or GitLab MR URL shape is `../review/
 * detectProvider.ts`'s job, not this schema's: that check needs a real `GitProviderClient`
 * (`parsePrUrl()`), which this module deliberately never imports, keeping it importable from the
 * `worker` Vitest project with no `agents` package anywhere in its import graph (unlike
 * `../routes/reviews.ts` itself, which must import `./startRun.ts`).
 *
 * @param body The request's already-JSON-parsed body (or `null`/`undefined` for an unparseable
 * or absent body -- `zod` reports the same "invalid_type" issue for either).
 * @returns The validated body.
 * @throws {ProblemDetailsError} `400`, via `badRequest()`, when `url` is missing, not a string,
 * or empty after trimming.
 */
export function validateManualTriggerBody(body: unknown): ManualTriggerBody {
  const result = ManualTriggerBodySchema.safeParse(body);
  if (!result.success) {
    throw badRequest({
      detail:
        result.error.issues[0]?.message ??
        "Request body must be a JSON object with a non-empty url field.",
    });
  }
  return result.data;
}

const ListReviewRunsQuerySchema = z.object({
  page: z.coerce.number().int("page must be a whole number").min(1).default(1),
  pageSize: z.coerce
    .number()
    .int("pageSize must be a whole number")
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/** A validated, defaulted, and capped `GET /api/reviews` query. */
export interface ListReviewRunsQuery {
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Validate and default `GET /api/reviews`'s `?page=`/`?pageSize=` query parameters. Hono's own
 * `context.req.query()` always returns `string | undefined` for a single-valued parameter, so
 * `z.coerce.number()` is what turns `"2"` into `2` (and rejects `"abc"`) -- an omitted parameter
 * (`undefined`) instead falls through to this schema's own `.default()`.
 *
 * @param query The raw, still-string query parameter values.
 * @returns The validated, defaulted `page`/`pageSize` pair -- `pageSize` is always within
 * `[1, MAX_PAGE_SIZE]`.
 * @throws {ProblemDetailsError} `400`, via `badRequest()`, when a provided `page`/`pageSize`
 * value is not coercible to a positive integer, or `pageSize` exceeds {@link MAX_PAGE_SIZE}.
 */
export function validateListReviewRunsQuery(query: {
  readonly page?: string;
  readonly pageSize?: string;
}): ListReviewRunsQuery {
  const result = ListReviewRunsQuerySchema.safeParse({
    page: query.page,
    pageSize: query.pageSize,
  });
  if (!result.success) {
    throw badRequest({
      detail:
        result.error.issues[0]?.message ??
        "Invalid page/pageSize query parameters.",
    });
  }
  return result.data;
}
