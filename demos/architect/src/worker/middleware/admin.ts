import { forbidden } from "@adrianhall/cloudflare-toolkit/errors";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings";

/**
 * Require that `accessMiddleware` (`./access.ts`) verified an identity whose email matches the
 * operator-configured `ADMIN_EMAIL`, rejecting every other identity with an RFC 9457 `403`.
 *
 * `cloudflareAccess()` alone only proves that *some* valid Cloudflare Access identity from this
 * account's Zero Trust team authenticated -- unlike `GET /api/me` (`../routes/me.ts`), which
 * reports `isAdmin` to every identity so the client can conditionally render admin UI, every
 * route under `/api/admin` must itself refuse to serve a non-administrator, not merely rely on
 * the client not asking. Mount this after `accessMiddleware`/`upsertUserMiddleware` on
 * `adminRouter` (`../routes/admin.ts`) so it runs for every admin route, not re-derived per
 * handler -- mirroring `demos/url-shortener`'s `requireAdmin` (`middleware/require-admin.ts`).
 *
 * There is deliberately no D1 role column backing this check (docs/09-ARCHITECT.md's Access
 * Model): exactly one identity is ever the administrator, and it is set by the operator through
 * `.env`/Terraform, not by the application.
 *
 * @throws {ProblemDetailsError} `forbidden()` (403) when the verified identity's email does not
 * equal `ADMIN_EMAIL`.
 */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const identity = context.get("Cloudflare_Access_Identity");
  throwIfNull(
    identity,
    "requireAdmin must run after accessMiddleware has verified an identity",
  );
  if (identity.email !== context.env.ADMIN_EMAIL) {
    throw forbidden({
      detail:
        "This Cloudflare Access identity is not the configured administrator.",
    });
  }
  await next();
};
