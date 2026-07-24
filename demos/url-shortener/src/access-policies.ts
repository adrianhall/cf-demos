/**
 * Shared Cloudflare Access path policies for local development (`cloudflareAccessPlugin` in
 * `vite.config.ts`) and Worker validation (`cloudflareAccess` in
 * `src/worker/middleware/access.ts`).
 *
 * `/admin` is only ever evaluated by the local dev plugin: in production it is served directly
 * by the `ASSETS` binding (see `wrangler.jsonc.tpl`) and gated by Cloudflare Access at the edge,
 * never reaching this Worker's `cloudflareAccess` middleware at all. It stays listed here (with
 * `redirect: true`, appropriate for a page navigation) purely so local development reproduces
 * that same pre-login redirect without a real Access application in front of it.
 */
export const accessPolicies = [
  {
    pattern: /^\/api\/links(?:\/|$)/u,
    authenticate: true,
    redirect: false,
  },
  {
    pattern: /^\/api\/me(?:\/|$)/u,
    authenticate: true,
    redirect: false,
  },
  { pattern: /^\/admin(?:\/|$)/u, authenticate: true, redirect: true },
  { pattern: /^\/l(?:\/|$)/u, authenticate: false },
];
