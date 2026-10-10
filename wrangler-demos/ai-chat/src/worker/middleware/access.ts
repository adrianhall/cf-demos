import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Cloudflare Access credentials for every request and exposes the verified identity
 * on the Hono context. Audience validation is deliberately omitted for this demo, following
 * `demos/chat` and `demos/todo-app`: the caller's identity (email) is derived from the verified
 * Access identity on every request and never from client input. The team domain is instead
 * resolved automatically from the `CLOUDFLARE_TEAM_DOMAIN` Worker variable.
 */
export const accessMiddleware = cloudflareAccess({
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
