import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { UserRepository } from "../users/repository";

/**
 * Authenticated identity API mounted at `/api/me`.
 *
 * This is also the sole place `UserRepository.ensureUser()` runs
 * (docs/06-AGENTIC-CHAT.md Phase 1, step 6): every verified sign-in upserts a D1 user row and
 * idempotently re-applies the configured administrator role, so no separate registration or
 * admin-bootstrap step exists anywhere else in this Worker.
 */
export const meRouter = new Hono<AppBindings>();

/** Return the verified identity and its D1-flagged administrator role. */
meRouter.get("/", async (context) => {
  const identity = context.get("Cloudflare_Access_Identity");
  const repository = new UserRepository(context.env.DB);
  const user = await repository.ensureUser(
    identity.email,
    identity.email === context.env.ADMIN_EMAIL,
  );
  return context.json({ email: user.email, isAdmin: user.isAdmin });
});
