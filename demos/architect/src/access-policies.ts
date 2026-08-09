import type { PathPolicy } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Shared Cloudflare Access path policies for local development
 * (`cloudflareAccessPlugin()` in `vite.config.ts`) and Worker validation
 * (`cloudflareAccess()` in `src/worker/middleware/access.ts`).
 *
 * The public catch-all is intentionally last, matching `demos/media-drop`: every future
 * authenticated path must be added ahead of it so a new route cannot silently inherit public
 * access. `/app*` is only ever evaluated by the local dev plugin — in production it is served
 * directly by the `ASSETS` binding (see `wrangler.jsonc.tpl`) and gated by the real Access
 * application at the edge, never reaching this Worker's `cloudflareAccess` middleware at all. It
 * stays listed here (with `redirect: true`, appropriate for a page navigation) purely so local
 * development reproduces that same pre-login redirect without a real Access application in front
 * of it.
 *
 * `/api/share` is listed *ahead of* the general `/api` policy so its anonymous share-token
 * resolver (`src/worker/routes/shares.ts`) stays public even though it lives under the otherwise
 * authenticated `/api/*` prefix -- `cloudflareAccess()` evaluates these patterns in order and
 * uses the first match, matching `infra/access.tf`'s narrower `app` Access application
 * destinations, which likewise omit `/api/share/*` so it falls through to the hostname-wide
 * public `bypass` application in production (docs/09-ARCHITECT.md's Access Model). The public
 * read-only share *page* (`/s/:token`) needs no equivalent entry: it already falls through to
 * the trailing public catch-all below, exactly like `/blueprints`.
 */
export const accessPolicies: PathPolicy[] = [
  { pattern: /^\/api\/share(?:\/|$)/u, authenticate: false },
  { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false },
  { pattern: /^\/app(?:\/|$)/u, authenticate: true, redirect: true },
  { pattern: /^\//u, authenticate: false },
];
