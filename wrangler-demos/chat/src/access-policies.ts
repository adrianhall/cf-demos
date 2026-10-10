/**
 * Shared Cloudflare Access path policies for local Vite development and Worker API validation.
 * Production Access protects the entire `chat.cfapps.uk` hostname at the edge with a single
 * self-hosted application backed by an `allow` policy — there is no public bypass application,
 * since every participant must have a verified identity. The page policy lets the local emulator
 * mirror that behavior even though page requests bypass the Worker in production.
 *
 * Every entry is `authenticate: true`, so this array is fail-safe: a route added later with no
 * earlier, more specific match still falls through to the authenticated catch-all.
 */
export const accessPolicies = [
  {
    // API and WebSocket-upgrade requests must receive a status code, not an HTML redirect, so
    // a fetch() or WebSocket handshake can react to a 401/403 instead of following a redirect.
    pattern: /^\/api(?:\/|$)/u,
    authenticate: true,
    redirect: false,
  },
  {
    pattern: /^\//u,
    authenticate: true,
    redirect: true,
  },
];
