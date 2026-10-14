/**
 * @file Cloudflare Access path policies shared by the Worker middleware and the local Vite plugin.
 *   One definition serves both so local development exercises the same audience check as the
 *   deployed Worker. There is no public surface: every API route authenticates. `/api/*` answers an
 *   unauthenticated request with an RFC 9457 `401` (`redirect: false`), because the SPA's `fetch`
 *   cannot follow a login redirect usefully; page routes redirect to sign-in.
 */

import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Build the ordered policy list for one Access audience.
 *
 * @param audience Access Application Audience tag every JWT must carry. Required because every
 *   Access application in a team shares one JWKS, so a token for an unrelated application would
 *   otherwise verify.
 * @returns The policies; the first matching pattern wins.
 */
export function buildAccessPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/mcp$/u, authenticate: true, redirect: false, audience },
    { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\//u, authenticate: true, redirect: true, audience }
  ];
}
