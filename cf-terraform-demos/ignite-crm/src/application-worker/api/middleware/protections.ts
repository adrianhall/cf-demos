/**
 * @file Request protections: request identifiers, same-origin enforcement, and JSON-only bodies.
 */

import type { MiddlewareHandler } from 'hono';
import { forbidden, unsupportedMediaType } from '@adrianhall/cloudflare-toolkit/errors';
import type { ApiEnv } from '../context.ts';

/**
 * Methods that never change state and so need no origin check.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Assign a request identifier and echo it as `X-Request-Id`.
 *
 * The identifier is always generated here; a client-supplied `X-Request-Id` is ignored so a caller
 * cannot forge correlation with another user's audit events.
 *
 * @returns The middleware.
 */
export function requestId(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const id = crypto.randomUUID();
    context.set('requestId', id);
    await next();
    context.res.headers.set('X-Request-Id', id);
  };
}

/**
 * Reject cross-site state-changing requests.
 *
 * The SPA and API share one origin, so a legitimate mutation always carries a same-origin `Origin`
 * (browsers send it on every non-GET `fetch`) or `Sec-Fetch-Site: same-origin`. Cookie-borne Access
 * sessions make this check necessary: without it, another site could submit a form that the browser
 * would send with the user's `CF_Authorization` cookie.
 *
 * @returns The middleware.
 * @throws {ProblemDetailsError} `403` when the request is cross-site.
 */
export function sameOrigin(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    if (!SAFE_METHODS.has(context.req.method)) {
      const origin = context.req.header('Origin');
      const site = context.req.header('Sec-Fetch-Site');
      const expected = new URL(context.req.url).origin;
      // A browser's same-origin JSON mutation carries Origin. A same-origin Fetch Metadata header
      // is accepted as a fallback for non-browser clients, but an absent pair fails closed.
      const originOk = origin === undefined ? site === 'same-origin' : origin === expected;
      const siteOk = site === undefined || site === 'same-origin' || site === 'none';
      if (!originOk || !siteOk) {
        throw forbidden({ detail: 'Cross-site requests are not allowed.' });
      }
    }
    await next();
  };
}

/**
 * Require a JSON content type on requests that carry a body.
 *
 * Rejecting form and `text/plain` bodies removes the "simple request" shapes a cross-site form can
 * produce, complementing {@link sameOrigin}.
 *
 * @returns The middleware.
 * @throws {ProblemDetailsError} `415` for a body that is not `application/json`.
 */
export function jsonOnly(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    if (!SAFE_METHODS.has(context.req.method)) {
      const type = context.req.header('Content-Type') ?? '';
      const length = context.req.header('Content-Length');
      const hasBody = (length !== undefined && length !== '0') || context.req.raw.body !== null;
      if (hasBody && !/^application\/json(?:\s*;|$)/iu.test(type)) {
        throw unsupportedMediaType({ detail: 'Request bodies must be application/json.' });
      }
    }
    await next();
  };
}
