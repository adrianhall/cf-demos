import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies, used by both the local development plugin
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and the deployed Worker's middleware
 * (`accessMiddleware` in `src/worker/middleware/access.ts`).
 *
 * Keeping one definition for both is the point: local development and production evaluate the
 * identical policy list, so an authorization mistake cannot hide behind a development-only bypass.
 *
 * The Playground has **no public surface**. Every panel can spend real inference credit, and every
 * inference request is attributed to the signed-in user in AI Gateway metadata — an anonymous
 * request would be an unattributable charge. Both entries therefore set `authenticate: true`; they
 * differ only in how an unauthenticated request is answered:
 *
 * - `/api/*` uses `redirect: false`, so the single-page application's `fetch` calls receive an RFC
 *   9457 `401` they can render, rather than the HTML of a login page.
 * - Everything else uses `redirect: true`, appropriate for a page navigation.
 *
 * Note that "no public surface" is not the same as "restricted to named people". The Access policy
 * in `infra/access.tf` admits anyone who can authenticate with the team's identity provider; the
 * demo is meant to be handed to a colleague. Authentication is there to attribute usage, not to
 * gatekeep it.
 *
 * The page policy is only ever exercised locally. In production, pages are served directly by the
 * `ASSETS` binding (see `cloudflare.config.ts`) behind a Cloudflare Access application that gates
 * the whole hostname at the edge, so a page request never reaches this Worker. It stays listed so
 * local development reproduces that same pre-login redirect without a real Access application in
 * front of it.
 *
 * @param audience Cloudflare Access Application Audience (AUD) tag that every authenticated request
 *   must carry in its JWT `aud` claim. Required, and threaded through from the Terraform output of
 *   the same name, because every Access application in a team shares one JWKS: without an `aud`
 *   check, a token minted for an unrelated application in the same team would be accepted here
 *   too.
 * @returns The ordered policy list; the first pattern that matches a request path wins.
 */
export function buildAccessPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\//u, authenticate: true, redirect: true, audience }
  ];
}
