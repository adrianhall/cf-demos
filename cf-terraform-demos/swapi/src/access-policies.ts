import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies, used by both the local development plugin
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and the deployed Worker's middleware
 * (`cloudflareAccess` in `src/worker/middleware/access.ts`).
 *
 * Keeping one definition for both is the point: local development and production evaluate the
 * identical policy list, so an authorization mistake cannot hide behind a development-only bypass.
 *
 * Like the sibling `todo` demo — and unlike `link` — this application has **no public surface**, so
 * there is no bypass policy here. Every entry sets `authenticate: true`; they differ only in how an
 * unauthenticated request is answered:
 *
 * - `/graphql` uses `redirect: false`. GraphiQL reaches it with `fetch`, so an RFC 9457 `401` it can
 *   render in its response pane is far more useful than the HTML of a login page, which would
 *   otherwise arrive as an unparseable GraphQL response.
 * - Everything else — including `/` and the GraphiQL console document itself — uses `redirect: true`,
 *   which is the right answer for a page navigation.
 *
 * Both are genuinely exercised in this demo, which is a difference from `todo`: there, pages come
 * from the `ASSETS` binding and never reach the Worker, so only the API policy mattered in
 * production. Here GraphQL Yoga serves the console from inside the Worker, so the page policy is
 * enforced by this middleware on the deployed application too.
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
    { pattern: /^\/graphql(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\//u, authenticate: true, redirect: true, audience }
  ];
}
