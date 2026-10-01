import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies, used by both the local development plugin
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and the deployed Worker's middleware
 * (`createAccessMiddleware` in `src/worker/middleware/access.ts`).
 *
 * Keeping one definition for both is the point: local development and production evaluate the
 * identical policy list, so an authorization mistake cannot hide behind a development-only bypass.
 *
 * Unlike the sibling `todo`, `chat`, and `swapi` demos, this application has a genuinely public
 * surface. The middleware runs with `defaultAction: 'block'`, so an unmatched path fails closed and
 * every public path needs an explicit `authenticate: false` entry. The deployed equivalents are the
 * Access applications in `infra/access.tf`: a hostname-wide bypass plus a narrower application
 * protecting `/admin*`, `/api/links*`, and `/api/me*`.
 *
 * - `/api/links` and `/api/me` use `redirect: false`, so the SPA's `fetch` calls receive an RFC 9457
 *   `401` they can render rather than the HTML of a login page.
 * - `/admin` uses `redirect: true`, appropriate for a page navigation. It is only ever evaluated by
 *   the local dev plugin: in production it is served directly by the `ASSETS` binding (see
 *   `cloudflare.config.ts`) and gated by Cloudflare Access at the edge, never reaching this
 *   Worker's middleware. It stays listed so local development reproduces that same pre-login
 *   redirect without a real Access application in front of it.
 * - `/l/:code` is the public short-link redirect, the whole point of the demo.
 *
 * @param audience Cloudflare Access Application Audience (AUD) tag that every authenticated request
 *   must carry in its JWT `aud` claim. Required, and threaded through from the Terraform output of
 *   the same name, because every Access application in a team shares one JWKS: without an `aud`
 *   check, a token minted for an unrelated application in the same team would be accepted here too.
 *   It is applied only to authenticating policies — a bypass policy has no token to check.
 * @returns The ordered policy list; the first pattern that matches a request path wins.
 */
export function buildAccessPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/api\/links(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/api\/me(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/admin(?:\/|$)/u, authenticate: true, redirect: true, audience },
    { pattern: /^\/l(?:\/|$)/u, authenticate: false }
  ];
}
