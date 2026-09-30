import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies, used by both the local development plugin
 * (`cloudflareAccessPlugin` in `vite.config.ts`) and the deployed Worker's middleware
 * (`cloudflareAccess` in `src/worker/middleware/access.ts`).
 *
 * Keeping one definition for both is the point: local development and production evaluate the
 * identical policy list, so an authorization mistake cannot hide behind a development-only bypass.
 *
 * Like the sibling `todo` demo and unlike `link`, this application has **no public surface**. Every
 * participant must be identified, because attributing messages to people is the entire subject of
 * the demo — an anonymous participant would have nothing meaningful to show. That is also why there
 * is no `/_next/*` bypass here: no document has to render for an unauthenticated visitor, so its
 * client chunks are only ever requested by a browser that already holds a valid Access session and
 * sends the cookie with them.
 *
 * Both entries therefore set `authenticate: true`; they differ only in how an unauthenticated
 * request is answered:
 *
 * - `/api/*` uses `redirect: false`, so the React client's `fetch` calls receive an RFC 9457 `401` it
 *   can render. This covers the WebSocket upgrade at `/api/channels/:channel/socket` too, and that
 *   is the more important half: a browser's `WebSocket` constructor cannot follow a redirect to a
 *   login page, so redirecting an unauthenticated upgrade would surface as an unexplained
 *   connection failure instead of an authentication error. Putting the upgrade under the same
 *   `/api/` prefix as everything else is what lets one policy cover it.
 * - Everything else uses `redirect: true`, appropriate for a page navigation.
 *
 * The page policy is not enforced by this Worker's Hono middleware in production. Vinext's App
 * Router entrypoint serves pages, and only `app/api/**` route handlers delegate into the Hono
 * application (see `src/worker/index.ts`), so a page request never reaches that middleware. Pages
 * are protected instead by the Cloudflare Access application in `infra/access.tf`, which gates the
 * whole hostname at the edge, and locally by the Vite plugin — which is exactly why the page entry
 * stays in this shared list rather than being dropped as dead configuration.
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
