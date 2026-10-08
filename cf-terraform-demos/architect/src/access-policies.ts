import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies, used by both the local development plugin
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and the deployed Worker's middleware
 * (`createAccessMiddleware` in `src/worker/middleware/access.ts`).
 *
 * Keeping one definition for both is the point: local development and production evaluate the
 * identical policy list, so an authorization mistake cannot hide behind a development-only bypass.
 * The list mirrors the two Access applications in `infra/access.tf`, and the two are reviewed
 * together — getting the ordering wrong breaks a visibly different thing in each place.
 *
 * Order matters: the first pattern that matches a request path wins, and the public catch-all is
 * deliberately last. Every future authenticated path must be added _ahead_ of it so a new route
 * cannot silently inherit public access.
 *
 * Three decisions are load-bearing:
 *
 * - **`/api/shares/*` is listed ahead of the general `/api/` policy.** The anonymous share-token
 *   resolver lives under the otherwise authenticated `/api/` prefix, so without this earlier
 *   carve-out it would authenticate. It matches the narrower `app` Access application in
 *   `infra/access.tf`, whose destination list likewise omits it so the request falls through to the
 *   hostname-wide public application in production.
 * - **Every `/api/` entry sets `redirect: false` explicitly.** Without it, an API caller sending
 *   `Accept: text/html` is answered with the HTML of a login page instead of an RFC 9457 `401` it
 *   can render — and a future `WebSocket` constructor cannot follow such a redirect at all.
 * - **`/app*` stays listed even though production never evaluates it here.** In production those
 *   pages are served directly by the `ASSETS` binding behind the real Access application, so the
 *   request never reaches this Worker. The entry exists so local development reproduces the same
 *   pre-login redirect without a real Access application in front of it.
 *
 * `/mcp*` is listed now, ahead of the public catch-all, even though no MCP route exists yet. That
 * ordering is the point: the catch-all is a default-public rule, so a route added later without a
 * policy of its own would silently inherit anonymous access. Declaring the posture with the rest of
 * the list means the Worker fails closed on that path from today, and the later phase that adds the
 * route adds no authorization decision at all. It authenticates like `/api` and never redirects,
 * because an MCP client is not a browser navigation and can no more complete a redirect to a login
 * page than a `fetch` can.
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
    // Liveness only. Public so the deployment can be probed without an identity, and it reveals
    // nothing an anonymous visitor could not already infer from the landing page.
    { pattern: /^\/api\/health(?:\/|$)/u, authenticate: false },
    // Anonymous read-only share resolution. See the carve-out note above.
    { pattern: /^\/api\/shares(?:\/|$)/u, authenticate: false },
    { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience },
    // Reserved for the later MCP phase. Declared now so the path is never default-public; see the
    // note above.
    { pattern: /^\/mcp(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/app(?:\/|$)/u, authenticate: true, redirect: true, audience },
    // The landing page, the blueprint gallery, the MCP connection guide and the read-only share
    // viewer. The guide deliberately lives at `/guides/mcp`, not `/mcp-guide`: Terraform's
    // authenticated `${local.hostname}/mcp*` destination wildcard would capture the latter at the
    // Access edge even though the stricter regular expression above would not, silently making the
    // page that explains how to sign in demand a login first. See `./mcp-route.ts`.
    { pattern: /^\//u, authenticate: false }
  ];
}
