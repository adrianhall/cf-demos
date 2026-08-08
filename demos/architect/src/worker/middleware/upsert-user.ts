import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../bindings";
import { UserRepository } from "../users/repository";

/**
 * Record the verified Cloudflare Access identity in the lightweight `users` directory on every
 * authenticated request, matching CF-Architect's own upsert-on-auth pattern
 * (docs/09-ARCHITECT.md's Data Model). Mounted after `accessMiddleware`
 * (`./access.ts`) on every `/api/*` route; a no-op when the request reached this point without a
 * verified identity (a public API route, once one exists).
 *
 * The directory exists solely to back the admin user-directory view added in Phase 4 — it is
 * never consulted for authorization, which is why this middleware performs no admin check of
 * its own.
 */
export const upsertUserMiddleware: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const identity = context.get("Cloudflare_Access_Identity");
  if (identity !== undefined) {
    await new UserRepository(context.env.DB).upsert(identity.email);
  }
  await next();
};
