import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Cloudflare Access middleware protecting every route except public short-link redirects.
 * Local development uses the toolkit's development token flow.
 */
export const accessMiddleware = cloudflareAccess({
  defaultAction: "block",
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
