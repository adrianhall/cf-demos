import { forbidden } from "@adrianhall/cloudflare-toolkit/errors";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings";

/**
 * Require that `accessMiddleware` (`./access.ts`) verified an identity whose email matches
 * `ADMIN_EMAIL`, rejecting everything else with an RFC 9457 `403`.
 *
 * `cloudflareAccess` alone only proves that *some* valid Cloudflare Access JWT was presented —
 * every Access application in a Cloudflare Access team shares the same JWKS, so without this
 * check a token minted for a different, unrelated Access application in the same team would
 * also be accepted here (cross-application token replay). Mount this after `accessMiddleware`
 * on every management route (`/api/links`, `/api/me`) so the API itself enforces the specific
 * administrator identity, not just "someone from this Cloudflare Access team" — the same identity
 * `/admin*` relies on Cloudflare Access to enforce at the edge in production.
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
    context.var.LOGGER.warn(
      `requireAdmin: identity (email = ${identity.email}) does not match admin (${context.env.ADMIN_EMAIL})`,
    );
    throw forbidden({
      detail:
        "This Cloudflare Access identity is not the configured administrator.",
    });
  }
  await next();
};
