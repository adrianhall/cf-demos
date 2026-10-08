import type { MiddlewareHandler } from 'hono';
import { forbidden, unsupportedMediaType } from '@adrianhall/cloudflare-toolkit/errors';
import type { AppBindings } from '../bindings.ts';

/**
 * HTTP methods that change state and therefore need both checks below.
 *
 * `GET` and `HEAD` are absent deliberately: they are the methods a cross-origin page may
 * legitimately cause, and the browser's own CORS rules already stop it reading the response.
 */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Methods that carry a request body this application expects to be JSON.
 *
 * `DELETE` is excluded: it changes state, so it needs the origin check, but it carries no body, so
 * demanding a JSON content type from it would reject a perfectly well-formed request.
 */
const JSON_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Paths this middleware deliberately does not guard.
 *
 * Only the remote MCP endpoint is listed, and the carve-out is explicit rather than a side effect
 * of where the middleware happens to be mounted, so removing it is a decision somebody has to take
 * rather than something a refactor can do by accident.
 *
 * **Why `/mcp` is exempt.** The checks below exist to stop a page the user did not write causing a
 * state-changing request from their browser. Both of their signals — `Sec-Fetch-Site` and `Origin`
 * — are set by a _browser_, and the "neither header present" case is rejected precisely because a
 * legitimate same-origin browser `fetch` always sends one. An MCP client is not a browser: it sends
 * neither, so every tool call would be refused with a `403` that looks exactly like an Access
 * failure while being nothing of the kind.
 *
 * Relaxing it costs nothing here, because the attack the middleware prevents does not exist on this
 * route. Cross-site request forgery works by riding an _ambient_ credential — a cookie the browser
 * attaches whether or not the page meant to. An MCP client authenticates with an OAuth bearer token
 * that Cloudflare Access resolves at the edge; no browser attaches it, no page can cause it to be
 * sent, and a request without it never reaches this Worker at all because the Access middleware
 * refuses it first.
 *
 * The media-type check goes with it for a smaller reason: the MCP handler performs its own, with
 * the protocol's own `415` answer, so duplicating it here would only change which error a client
 * sees.
 */
const UNGUARDED_PATHS = new Set(['/mcp']);

/**
 * Matches exactly the `application/json` media type, optionally followed by parameters.
 *
 * Anchored and explicit about what may follow the type, rather than a prefix test: `startsWith`
 * also admits `application/jsonp`, which is a different media type entirely and precisely the kind
 * of near-miss this check exists to refuse. A parameter must be introduced by `;` — optionally with
 * surrounding whitespace, which RFC 9110 permits — so `application/json; charset=utf-8` is accepted
 * while `application/json-patch+json` is not.
 */
const JSON_MEDIA_TYPE = /^application\/json\s*(?:;.*)?$/iu;

/**
 * Rejects a state-changing request that does not come from this application's own origin, and one
 * whose body is not exactly JSON.
 *
 * Two independent signals decide same-origin, preferring the one page JavaScript cannot forge:
 *
 * - **`Sec-Fetch-Site`** (Fetch Metadata) is set by the browser itself and is not settable from
 *   script. When present it must read `same-origin`.
 * - **`Origin`** is the fallback. Browsers always send it for a state-changing `fetch`, same-origin
 *   or not, so it must exactly equal this request's own origin.
 *
 * A request carrying **neither** header is rejected rather than allowed through. A legitimate
 * same-origin browser `fetch` always sends at least one of them for these methods, so their total
 * absence marks a non-browser or forged request — and "missing" must fail for the same reason
 * "foreign" does, or the check is trivially bypassed by omitting a header.
 *
 * The exact JSON content type matters for a second, independent reason: `application/json` is not a
 * CORS-safelisted content type, so requiring it means a cross-origin form submission — which can
 * only send safelisted types and cannot be preflighted away — cannot reach a mutating endpoint at
 * all.
 *
 * {@link UNGUARDED_PATHS} is exempt. Read that constant's documentation before adding to it: the
 * exemption is sound for a bearer-authenticated non-browser caller and unsound for anything a
 * browser can reach.
 *
 * @throws {ProblemDetailsError} `403` when a state-changing request is cross-origin or carries
 *   neither origin signal, and `415` when a body-carrying method's `Content-Type` is not
 *   `application/json`.
 */
export const enforceSameOriginJson: MiddlewareHandler<AppBindings> = async (context, next) => {
  if (!STATE_CHANGING_METHODS.has(context.req.method)) {
    await next();
    return;
  }

  // Compared against the parsed pathname rather than the raw URL, so a query string or a
  // fragment cannot be used to dodge the exemption in either direction.
  if (UNGUARDED_PATHS.has(new URL(context.req.url).pathname)) {
    await next();
    return;
  }

  const secFetchSite = context.req.header('sec-fetch-site');
  const origin = context.req.header('origin');
  const requestOrigin = new URL(context.req.url).origin;

  const isSameOrigin =
    secFetchSite === undefined
      ? origin !== undefined && origin === requestOrigin
      : secFetchSite === 'same-origin';

  if (!isSameOrigin) {
    throw forbidden({ detail: 'Cross-origin requests are not permitted.' });
  }

  if (JSON_BODY_METHODS.has(context.req.method)) {
    const contentType = context.req.header('content-type')?.trim() ?? '';
    if (!JSON_MEDIA_TYPE.test(contentType)) {
      throw unsupportedMediaType({ detail: 'Content-Type must be application/json.' });
    }
  }

  await next();
};
