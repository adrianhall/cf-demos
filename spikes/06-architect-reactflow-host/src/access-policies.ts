import type { PathPolicy } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Shared Cloudflare Access path policies, used by both `cloudflareAccess()` in the Worker
 * (`src/worker/index.ts`) and `cloudflareAccessPlugin()` in `vite.config.ts` for local
 * development.
 *
 * This probe stands in for CF-Architect's future `/app*` authenticated editor shell: unlike the
 * real demo (which also has a public landing page and share viewer — see
 * docs/09-ARCHITECT.md's Access Model), everything in this spike requires authentication,
 * including the page route itself, so the plugin's page-level gating behavior can be exercised
 * alongside the API route.
 */
export const accessPolicies: PathPolicy[] = [
  // `redirect: false` matters here, not just stylistically: without it, a request the dev
  // plugin classifies as a browser navigation (an `Accept: text/html` header, or a real
  // browser's `Sec-Fetch-Mode: navigate`) gets redirected to the login page instead of the
  // JSON 401 an API caller expects — see REPORT.md's "curl vs. browser navigation" finding.
  { pattern: /^\/api\//u, authenticate: true, redirect: false },
  { pattern: /^\//u, authenticate: true, redirect: true },
];
