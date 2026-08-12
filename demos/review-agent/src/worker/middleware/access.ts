import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../access-policies";

/**
 * Cloudflare Access middleware, mounted once and globally in `src/worker/index.ts`
 * (docs/07-PR-REVIEW-AGENT.md, "Access Model"). Every path defaults to requiring
 * authentication (`defaultAction: "block"`); `accessPolicies` carves out the two webhook paths
 * as unauthenticated, matching the `bypass`-policy Access application in
 * `infra/review-agent.tf`.
 *
 * `audience` is deliberately not validated: this hostname has exactly one authenticated
 * identity purpose (any signed-in user), so there is no cross-application token replay concern
 * beyond what a single Access application already has.
 */
export const accessMiddleware = cloudflareAccess({
  defaultAction: "block",
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
