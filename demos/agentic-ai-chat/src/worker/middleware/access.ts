import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Cloudflare Access credentials for every route and exposes the verified identity on
 * the Hono context.
 *
 * Unlike `demos/todo-app`, this demo pins `audience` to the real Access application's AUD tag
 * (docs/06-AGENTIC-CHAT.md Section 6.5): every chat holds sensitive, billable AI conversation
 * history, so accepting a token minted for *any other* Access application in this Cloudflare
 * Access team (cross-application token replay -- every application in a team shares the same
 * JWKS) is not an acceptable trade-off here. The tag is threaded in as a Vite build-time define
 * (`VITE_ACCESS_AUDIENCE`, set from the `access_audience` Terraform output on `npm run deploy` --
 * see `package.json`'s `deploy:worker:publish` script) rather than a generated Worker var,
 * because `cloudflareAccess()` reads `audience` once at Worker module-load time, before any
 * request-scoped `env` binding is available (AGENTS.md, "Runtime And Packages"). Local
 * development leaves it `undefined`, which is safe: `enableDevTokens` is only ever `true` there,
 * and `cloudflareAccess()` silences its "audience omitted" warning whenever dev tokens are
 * enabled.
 */
export const accessMiddleware = cloudflareAccess({
  audience: import.meta.env.VITE_ACCESS_AUDIENCE,
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
