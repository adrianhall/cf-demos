import {
  forbidden,
  unsupportedMediaType,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { MiddlewareHandler } from "hono";

/** HTTP methods that carry a request body this Worker expects to be JSON. */
const JSON_BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Reject a state-changing `/api/*` request that is missing, or does not match, this Worker's
 * own origin, and reject one whose body is not exactly `application/json`
 * (docs/09-ARCHITECT.md's Access Model: "Require same-origin requests and an exact JSON content
 * type for every state-changing API request").
 *
 * Two independent signals decide same-origin, preferring the one a browser cannot spoof:
 *
 * - `Sec-Fetch-Site` (Fetch Metadata, sent automatically by every modern browser and not
 *   settable by page JavaScript) must read `same-origin` when present.
 * - Otherwise, the `Origin` header (always sent by browsers for state-changing `fetch()`
 *   requests, same-origin or not) must exactly equal this request's own origin.
 *
 * A request with **neither** header is rejected, not allowed through: `demos/09-ARCHITECT.md`'s
 * non-negotiable test list requires state-changing requests to reject a *missing* origin, not
 * only a foreign one -- a legitimate same-origin browser `fetch()` always sends at least one of
 * these two headers for `POST`/`PUT`/`PATCH`/`DELETE`, so their total absence marks a
 * non-browser or forged request, not an ordinary gap to tolerate.
 *
 * Mounted in `../index.ts` ahead of every mutating verb under `/api/*`, after
 * `accessMiddleware`/`upsertUserMiddleware` -- an unauthenticated request is already rejected by
 * then, so this only ever runs for a verified identity's own mutating request.
 */
export const enforceSameOriginJson: MiddlewareHandler = async (
  context,
  next,
) => {
  const secFetchSite = context.req.header("sec-fetch-site");
  const origin = context.req.header("origin");
  const requestOrigin = new URL(context.req.url).origin;

  const isSameOrigin =
    secFetchSite === undefined
      ? origin !== undefined && origin === requestOrigin
      : secFetchSite === "same-origin";

  if (!isSameOrigin) {
    throw forbidden({ detail: "Cross-origin requests are not permitted." });
  }

  if (JSON_BODY_METHODS.has(context.req.method)) {
    const contentType = context.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw unsupportedMediaType({
        detail: "Content-Type must be application/json.",
      });
    }
  }

  await next();
};
