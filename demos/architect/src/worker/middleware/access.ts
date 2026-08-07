import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Access tokens for authenticated editor and API paths.
 *
 * The audience is supplied only during the production build. Development tokens are enabled only
 * in a Vite development build and are issued by the local Access emulator.
 */
export const accessMiddleware = cloudflareAccess({
  audience: import.meta.env.VITE_ACCESS_AUDIENCE,
  defaultAction: "block",
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
