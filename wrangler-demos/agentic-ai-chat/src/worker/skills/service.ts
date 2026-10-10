import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { fetchSkillSourceBody } from "./source";
import {
  deleteSkillDirectory,
  putSkillMarkdown,
  skillDirectoryKey,
} from "./storage";
import { SkillsRepository } from "./repository";
import type { Skill, SkillSourceType } from "./types";
import {
  buildSkillMarkdown,
  sanitizeSkillDescription,
  sanitizeSkillName,
  validateSkillBody,
} from "./validation";

/** Collaborators {@link createSkill}/{@link removeSkillAndCleanup} need, threaded in by
 * `../routes/skills.ts`/`admin.ts` rather than imported directly, so both functions stay
 * testable with plain fakes instead of real Cloudflare bindings -- mirrors
 * `../agent/tools/write-markdown.ts`'s own `WriteMarkdownDeps` convention. */
export interface SkillServiceDeps {
  /** R2 bucket binding (`FILES`) a skill's `SKILL.md` is written to and removed from. */
  readonly bucket: R2Bucket;
  /** D1 capability used to query and update the `skills` catalog. */
  readonly database: Pick<D1Database, "prepare">;
}

/** One resolved skill source, after validating/fetching whichever shape the caller provided. */
interface ParsedSkillSource {
  readonly type: SkillSourceType;
  readonly body: string;
  readonly sourceRef: string | null;
}

/**
 * Validate and resolve a `POST /api/skills`/`POST /api/admin/skills` request body's `source`
 * field into its final instruction-body text, dispatching on `source.type` (docs/06-AGENTIC-CHAT.md
 * Phase 11, US-10's "each accepting an upload or a URL source" requirement).
 *
 * @param raw The request body's raw `source` field.
 * @returns The resolved source type, body text, and (for a URL source) the fetched URL.
 * @throws {ProblemDetailsError} `400` for a malformed `source` shape or an unreachable URL,
 * `422`/`413` from {@link validateSkillBody} for the resolved body itself.
 */
async function parseSkillSource(raw: unknown): Promise<ParsedSkillSource> {
  if (typeof raw !== "object" || raw === null) {
    throw badRequest({
      detail: 'source must be an object with a "type" of "upload" or "url".',
    });
  }
  const type = (raw as { type?: unknown }).type;
  if (type === "upload") {
    const content = (raw as { content?: unknown }).content;
    return {
      type: "upload",
      body: validateSkillBody(content),
      sourceRef: null,
    };
  }
  if (type === "url") {
    const url = (raw as { url?: unknown }).url;
    if (typeof url !== "string") {
      throw badRequest({ detail: "source.url must be a string." });
    }
    const body = await fetchSkillSourceBody(url);
    return { type: "url", body, sourceRef: url };
  }
  throw badRequest({ detail: 'source.type must be "upload" or "url".' });
}

/**
 * Create one personal or enterprise skill: validate its name/description/source, build its
 * `SKILL.md` content, write it to R2, then persist its catalog row -- shared by
 * `../routes/skills.ts` (`ownerEmail` = the caller) and `../routes/admin.ts`
 * (`ownerEmail = null`, already gated by `requireAdmin()` at the route level).
 *
 * @param deps Collaborators (R2 bucket, D1 database).
 * @param ownerEmail The new skill's scope: `null` for enterprise, an identity for personal.
 * @param body The request body's raw `name`/`description`/`source` fields.
 * @returns The newly persisted skill.
 * @throws {ProblemDetailsError} From {@link sanitizeSkillName}/{@link sanitizeSkillDescription}/
 * {@link parseSkillSource} for invalid input, or `422` when a skill with the same name already
 * exists in this scope ({@link SkillsRepository.findByNameInScope}'s own rationale).
 */
export async function createSkill(
  deps: SkillServiceDeps,
  ownerEmail: string | null,
  body: unknown,
): Promise<Skill> {
  if (typeof body !== "object" || body === null) {
    throw badRequest({ detail: "Request body must be a JSON object." });
  }
  const name = sanitizeSkillName((body as { name?: unknown }).name);
  const description = sanitizeSkillDescription(
    (body as { description?: unknown }).description,
  );
  const source = await parseSkillSource((body as { source?: unknown }).source);

  const repository = new SkillsRepository(deps.database);
  const existing = await repository.findByNameInScope(ownerEmail, name);
  if (existing !== null) {
    throw unprocessableContent({
      detail: `A skill named "${name}" already exists in this scope.`,
    });
  }

  const id = crypto.randomUUID();
  const r2Key = skillDirectoryKey(ownerEmail, id);
  const markdown = buildSkillMarkdown(name, description, source.body);
  await putSkillMarkdown(deps.bucket, r2Key, markdown);

  try {
    return await repository.create({
      id,
      ownerEmail,
      name,
      sourceType: source.type,
      sourceRef: source.sourceRef,
      r2Key,
    });
  } catch (error) {
    // Compensate for the orphaned R2 object a D1 failure would otherwise leave behind (Section
    // 11), mirroring `../agent/tools/write-markdown.ts`'s own ordering -- best-effort: a cleanup
    // failure here is never allowed to mask the original D1 error as the reason this failed.
    await deleteSkillDirectory(deps.bucket, r2Key).catch(() => {});
    throw error;
  }
}

/**
 * Remove an already-looked-up skill's D1 row, and its backing R2 directory only once that
 * removal actually happened -- shared by `../routes/skills.ts`/`admin.ts`, which have each
 * already confirmed the caller may delete this specific skill
 * ({@link SkillsRepository.findPersonalOwned}/{@link SkillsRepository.findEnterprise}) before
 * calling this.
 *
 * @param deps Collaborators (R2 bucket, D1 database).
 * @param skill The already-looked-up skill to remove.
 * @param scope Which removal query to run: `"personal"` scopes by {@link Skill.ownerEmail},
 * `"enterprise"` requires `ownerEmail` to already be `null`.
 */
export async function removeSkillAndCleanup(
  deps: SkillServiceDeps,
  skill: Skill,
  scope: "personal" | "enterprise",
): Promise<void> {
  const repository = new SkillsRepository(deps.database);
  const removed =
    scope === "personal" && skill.ownerEmail !== null
      ? await repository.removePersonal(skill.id, skill.ownerEmail)
      : await repository.removeEnterprise(skill.id);
  if (removed) {
    await deleteSkillDirectory(deps.bucket, skill.r2Key).catch(() => {});
  }
}
