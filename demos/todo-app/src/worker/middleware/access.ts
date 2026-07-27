import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Cloudflare Access credentials for API requests and exposes the verified identity on
 * the Hono context. Audience validation is deliberately omitted for this demo as specified by
 * its scenario; production demos should normally provide the application audience.
 */
export const accessMiddleware = cloudflareAccess({
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
