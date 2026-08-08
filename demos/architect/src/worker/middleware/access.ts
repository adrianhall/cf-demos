import { cloudflareAccess } from "@adrianhall/cloudflare-toolkit/hono";
import { accessPolicies } from "../../access-policies";

/**
 * Validates Cloudflare Access credentials for the authenticated `/app*` app shell and every
 * `/api/*` route, and exposes the verified identity on the Hono context. The public landing
 * page, `/blueprints` (Phase 2), and the read-only share viewer (Phase 3) fall through to the
 * shared policies' trailing public catch-all and are never challenged.
 *
 * This demo pins `audience` to the real, path-scoped Access application's AUD tag
 * (docs/09-ARCHITECT.md's Access Model): every diagram is private to its owner, so accepting a
 * token minted for *any other* Access application in this Cloudflare Access team (cross-
 * application token replay -- every application in a team shares the same JWKS) is not an
 * acceptable trade-off here. The tag is threaded in as a Vite build-time define
 * (`VITE_ACCESS_AUDIENCE`, set from the `access_audience` Terraform output -- see
 * `package.json`'s `deploy:worker:publish` script) rather than a generated Worker var, because
 * `cloudflareAccess()` reads `audience` once at Worker module-load time, before any
 * request-scoped `env` binding is available (AGENTS.md, "Runtime And Packages"). Local
 * development leaves it `undefined`, which is safe: `enableDevTokens` is only ever `true` there,
 * and `cloudflareAccess()` silences its "audience omitted" warning whenever dev tokens are
 * enabled.
 */
export const accessMiddleware = cloudflareAccess({
  audience: import.meta.env.VITE_ACCESS_AUDIENCE,
  defaultAction: "block",
  enableDevTokens: import.meta.env.DEV,
  policies: accessPolicies,
});
