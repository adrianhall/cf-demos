import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Cloudflare Access credentials for every `/api/*` request — including the
 * WebSocket upgrade route added in Phase 3 — and exposes the verified identity on the Hono
 * context. Audience validation is deliberately omitted for this demo as specified by its
 * scenario; the team domain is instead resolved automatically from the `CLOUDFLARE_TEAM_DOMAIN`
 * Worker variable.
 */
export const accessMiddleware = cloudflareAccess({
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
