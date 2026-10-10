import { forbidden } from "@adrianhall/cloudflare-toolkit/errors";
import { throwIfNull } from "@adrianhall/cloudflare-toolkit/guards";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings";
import { UserRepository } from "../users/repository";

/**
 * Require that the verified Cloudflare Access identity (`accessMiddleware`, `./access.ts`) also
 * holds this demo's D1-flagged administrator role, rejecting everything else with an RFC 9457
 * `403`. Mounted on every `/api/admin/*` route (docs/06-AGENTIC-CHAT.md Section 6.5, Phase 7,
 * US-6), after `accessMiddleware` has already run.
 *
 * "Administrator" is deliberately **not** a second Cloudflare Access application or policy --
 * Access has no concept of this demo's business role, and every application in a Cloudflare
 * Access team shares the same JWKS, so a second application would only prove "some valid token
 * from this team," not this demo's own role. `UserRepository.isAdmin()` is the one place that
 * role is actually decided, reading the same `users.is_admin` column `GET /api/me`'s
 * `ensureUser()` upsert maintains -- an identity that has never signed in (and so never had a
 * `users` row created) is correctly treated as non-administrator, not specially handled.
 *
 * @throws {ProblemDetailsError} `forbidden()` (`403`) when the verified identity does not hold
 * the administrator role.
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
  const repository = new UserRepository(context.env.DB);
  const isAdmin = await repository.isAdmin(identity.email);
  if (!isAdmin) {
    throw forbidden({
      detail: "This route requires this demo's administrator role.",
    });
  }
  await next();
};
