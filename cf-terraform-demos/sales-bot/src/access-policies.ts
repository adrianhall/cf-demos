import type { PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Build the policy list shared by local Access emulation and deployed middleware.
 *
 * @param audience Access application audience required on every JWT.
 * @returns Ordered policies whose API rule returns an API-safe authentication failure.
 */
export function buildAccessPolicies(audience: string): PathPolicy[] {
  return [
    { pattern: /^\/api(?:\/|$)/u, authenticate: true, redirect: false, audience },
    { pattern: /^\//u, authenticate: true, redirect: true, audience }
  ];
}
