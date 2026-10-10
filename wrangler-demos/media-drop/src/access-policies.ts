/**
 * Shared Cloudflare Access policy order for the Worker and local Vite edge emulator.
 *
 * The public catch-all is intentionally last. Every future authenticated path must be added
 * ahead of it so a new route cannot silently inherit public access.
 */
export const accessPolicies = [
  { pattern: /^\/api\/studio(?:\/|$)/u, authenticate: true, redirect: false },
  { pattern: /^\/studio(?:\/|$)/u, authenticate: true, redirect: true },
  { pattern: /^\//u, authenticate: false },
];
