import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates identities only for the shared policy's authenticated studio paths.
 *
 * Development tokens are accepted solely in Vite's development bundle; deployed Workers only
 * accept Cloudflare Access JWTs.
 */
export const accessMiddleware = cloudflareAccess({
  defaultAction: "block",
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
