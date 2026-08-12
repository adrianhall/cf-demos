import type { PathPolicy } from "@adrianhall/cloudflare-toolkit/hono";

/**
 * Shared Cloudflare Access path policies for both Worker validation
 * (`cloudflareAccess` in `src/worker/middleware/access.ts`) and local-development emulation
 * (`cloudflareAccessPlugin` in `vite.config.ts`), most-specific-pattern-first.
 *
 * This demo inverts AGENTS.md's canonical "public bypass by default" shape
 * (docs/07-PR-REVIEW-AGENT.md, "Explicit Exceptions" and "Access Model"): every path is
 * authenticated by default because triggering a review spends real AI Gateway budget, and only
 * the two webhook paths -- which GitHub/GitLab call with no Access identity at all -- bypass
 * Access entirely. This array mirrors the two `cloudflare_zero_trust_access_application`
 * resources in `infra/review-agent.tf` exactly: `authenticate: false` here corresponds to the
 * `bypass`-policy `webhooks` application, and every `authenticate: true` entry corresponds to
 * the hostname-wide `allow`-policy `demo` application.
 */
export const accessPolicies: PathPolicy[] = [
  { pattern: /^\/api\/webhooks\//, authenticate: false },
  { pattern: /^\/api\//, authenticate: true },
  { pattern: /^\/agents\//, authenticate: true },
  { pattern: /^\//, authenticate: true },
];
