/**
 * Shared Cloudflare Access path policies for local Vite development and Worker API validation.
 * Production Access protects the entire hostname at the edge; the page policy lets the local
 * emulator mirror that behavior even though page requests bypass the Worker in production.
 */
export const accessPolicies = [
  {
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
