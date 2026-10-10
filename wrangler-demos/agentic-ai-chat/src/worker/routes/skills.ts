import { notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { SkillsRepository } from "../skills/repository";
import { createSkill, removeSkillAndCleanup } from "../skills/service";

/** Personal skill management API mounted at `/api/skills` (docs/06-AGENTIC-CHAT.md Phase 11,
 * US-10). See `./admin.ts`'s `adminRouter` for the equivalent enterprise-skill routes -- the
 * same split `../chats/repository.ts`'s owner-scoped queries and
 * `../users/repository.ts`'s admin-only ones already establish, applied to skills instead of
 * chats/metadata. */
export const skillsRouter = new Hono<AppBindings>();

/** List the signed-in identity's own personal skills (US-10's "a personal skill is invisible to
 * other users" acceptance criterion, from its owner's own management view). */
skillsRouter.get("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const skills = await new SkillsRepository(context.env.DB).listPersonal(
    ownerEmail,
  );
  return context.json({ skills });
});

/** Add a personal skill, owned by the signed-in identity, from an upload or a URL source. */
skillsRouter.post("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const body = await context.req.json().catch(() => null);
  const skill = await createSkill(
    { bucket: context.env.FILES, database: context.env.DB },
    ownerEmail,
    body,
  );
  context
    .get("LOGGER")
    .info("skill_created", { skillId: skill.id, scope: "personal" });
  return context.json({ skill }, 201);
});

/**
 * Remove one of the signed-in identity's own personal skills. Scoped to its owner in the same
 * lookup that decides whether it exists at all (`SkillsRepository.findPersonalOwned()`), so a
 * foreign skill id reports the same `404` as one that never existed -- mirrors
 * `../chats/repository.ts`'s `findOwned()` "never confirm another user's resource id is valid"
 * rationale.
 */
skillsRouter.delete("/:id", async (context) => {
  const id = context.req.param("id");
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new SkillsRepository(context.env.DB);
  const skill = await repository.findPersonalOwned(id, ownerEmail);
  if (skill === null) {
    throw notFound({ detail: "Skill not found." });
  }
  await removeSkillAndCleanup(
    { bucket: context.env.FILES, database: context.env.DB },
    skill,
    "personal",
  );
  context
    .get("LOGGER")
    .info("skill_deleted", { skillId: id, scope: "personal" });
  return new Response(null, { status: 204 });
});
