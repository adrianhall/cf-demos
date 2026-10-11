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
 * Client-controllable request headers that carry identity at the Cloudflare edge. This Worker never
 * reads them — identity comes only from the verified Access JWT — but they are removed anyway so no
 * later code (or a future handler forwarding the request to the Data Worker) can mistake a client's
 * copy for a verified value.
 */
export const IDENTITY_HEADERS: readonly string[] = [
  'cf-access-authenticated-user-email',
  'cf-access-authenticated-user-id',
  'x-authenticated-user-email'
];

/**
 * Return a copy of request headers with every {@link IDENTITY_HEADERS} entry deleted. Header names
 * are case-insensitive, so `CF-ACCESS-AUTHENTICATED-USER-EMAIL` is removed too. The one place this
 * deletion happens, so it is tested once (`tests/unit/api/app.test.ts`).
 *
 * @param headers Incoming request headers.
 * @returns New headers without identity headers.
 */
export function withoutIdentityHeaders(headers: Headers): Headers {
  const clean = new Headers(headers);
  for (const name of IDENTITY_HEADERS) {
    clean.delete(name);
  }
  return clean;
}

/**
 * Replace the request with one whose identity headers are scrubbed, before Access verification
 * stores the trusted identity (specification §11). The Access JWT header and cookie are kept.
 *
 * @returns The middleware.
 */
export function scrubIdentityHeaders(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    const original = context.req.raw;
    if (IDENTITY_HEADERS.some((name) => original.headers.has(name))) {
      context.req.raw = new Request(original, {
        headers: withoutIdentityHeaders(original.headers)
      });
    }
    await next();
  };
}

/**
 * Headers set on every API response. JSON responses are never meant to render, frame, or leak a
 * referrer, so the policy is the strictest possible; the SPA's own page policy lives in
 * `public/_headers`, because static assets are served before Worker code runs.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Responses are per user and per request; no shared cache may keep them.
  'Cache-Control': 'no-store'
};

/**
 * Add {@link API_SECURITY_HEADERS} to every API response, including error responses produced by the
 * error handler (it runs inside `next()`).
 *
 * @returns The middleware.
 */
export function securityHeaders(): MiddlewareHandler<ApiEnv> {
  return async (context, next) => {
    await next();
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      context.res.headers.set(name, value);
    }
  };
}

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
