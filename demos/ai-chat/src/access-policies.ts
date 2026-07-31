/**
 * Shared Cloudflare Access path policies for local Vite development and Worker API validation.
 * Production Access protects the entire `ai-chat.cfapps.uk` hostname at the edge with a single
 * self-hosted application backed by an `allow` policy — there is no public bypass application,
 * since inference is billable compute and no route may be anonymous (see docs/05-AI-CHAT.md,
 * Access Model). The page policy lets the local emulator mirror that behavior even though page
 * requests bypass the Worker in production.
 *
 * Every entry is `authenticate: true`, so this array is fail-safe: a route added later with no
 * earlier, more specific match still falls through to the authenticated catch-all.
 */
export const accessPolicies = [
  {
    // API requests must receive a status code, not an HTML redirect, so a fetch() (including
    // one reading a Server-Sent Events stream) can react to a 401/403 instead of following a
    // redirect and failing to parse HTML as event-stream frames.
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
