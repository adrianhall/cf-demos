import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Shared Cloudflare Access path policies for local development (`cloudflareAccessPlugin` in
 * `vite.config.ts`) and Worker validation (`createAccessMiddleware` in
 * `src/worker/middleware/access.ts`).
 *
 * The middleware runs with `defaultAction: 'block'`, so an unmatched path fails closed. Every
 * genuinely public path therefore needs an explicit `authenticate: false` entry, and this one list
 * keeps local development and the deployed Worker agreeing on which those are. The deployed
 * equivalents are the Access applications in `infra/access.tf`: a hostname-wide bypass plus a
 * narrower application protecting `/admin*`, `/api/links*`, and `/api/me*`.
 *
 * Public entries, and why each one is public:
 *
 * - `/` — the public landing page (see `app/page.tsx`). It links to `/admin`, where Cloudflare Access
 *   challenges an administrator, and explains how public short URLs work. Anchored as `/^\/$/` so
 *   it cannot widen into "every path is public".
 * - `/_next/*` — Vinext's built client chunks, CSS, and RSC payload assets. An unauthenticated
 *   visitor must be able to load these to render the public root document at all.
 * - `/l/:code` — the public short-link redirect, the whole point of the demo.
 *
 * @param audience Cloudflare Access Application Audience (AUD) tag that every authenticated request
 *   must carry in its JWT `aud` claim. It is applied only to authenticating policies, because a
 *   bypass policy has no token to check.
 * @returns The ordered policy list; the first pattern that matches a request path wins.
 */
export function buildAccessPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/api\/links(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/api\/me(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/admin(?:\/|$)/u, authenticate: true, redirect: true, audience },
    { pattern: /^\/$/u, authenticate: false },
    { pattern: /^\/_next(?:\/|$)/u, authenticate: false },
    { pattern: /^\/l(?:\/|$)/u, authenticate: false }
  ];
}
