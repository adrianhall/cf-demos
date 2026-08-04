import type { Skill, SkillSourceType } from "./types";

/** Raw snake-cased `skills` row returned by D1. */
interface SkillRow {
  id: string;
  owner_email: string | null;
  name: string;
  source_type: string;
  source_ref: string | null;
  r2_key: string;
  created_at: string;
}

/** Convert D1's storage shape into the API representation. `row.source_type` is defensively
 * coerced back to `"upload"` for anything unrecognized, mirroring `../chats/repository.ts`'s
 * own `toChat()` coercion -- this table's `CHECK` constraint (migration 0005) already prevents
 * writing anything else, so this only guards a row this repository itself never wrote. */
function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    name: row.name,
    sourceType: (row.source_type === "url"
      ? "url"
      : "upload") as SkillSourceType,
    sourceRef: row.source_ref,
    r2Key: row.r2_key,
    createdAt: row.created_at,
  };
}

/** Input to {@link SkillsRepository.create}. */
export interface CreateSkillInput {
  /** Server-generated skill id, already embedded in {@link r2Key} (`./storage.ts`'s
   * `skillDirectoryKey()`). */
  readonly id: string;
  /** The owning identity, or `null` for an enterprise skill. */
  readonly ownerEmail: string | null;
  /** The already-sanitized display name (`./validation.ts`'s `sanitizeSkillName()`). */
  readonly name: string;
  /** How this skill's content was provided. */
  readonly sourceType: SkillSourceType;
  /** The source URL, or `null` for an uploaded skill. */
  readonly sourceRef: string | null;
  /** The R2 directory this skill's `SKILL.md` was already, successfully written to (Section
   * 11's "R2 write before D1 insert" ordering). */
  readonly r2Key: string;
}

/**
 * D1 persistence boundary for the personal/enterprise skill catalog (docs/06-AGENTIC-CHAT.md
 * Section 6.4, Phase 11, US-10) -- a management directory for `../routes/skills.ts`/`admin.ts`
 * to list and delete, never what `ChatAgent` reads at turn time (`./registry.ts` reads the
 * model-visible catalog directly from R2 instead, per Spike D).
 */
export class SkillsRepository {
  /** @param database D1 capability used to query and update this table. */
  constructor(private readonly database: Pick<D1Database, "prepare">) {}

  /**
   * Persist one skill's metadata. Called only after {@link ../storage.ts!putSkillMarkdown} has
   * already confirmed the R2 write (Section 11) -- never the other way around.
   *
   * @param input The skill's id, scope, name, source, and R2 directory.
   * @returns The persisted row.
   */
  async create(input: CreateSkillInput): Promise<Skill> {
    const skill: Skill = { ...input, createdAt: new Date().toISOString() };
    await this.database
      .prepare(
        `INSERT INTO skills (id, owner_email, name, source_type, source_ref, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        skill.id,
        skill.ownerEmail,
        skill.name,
        skill.sourceType,
        skill.sourceRef,
        skill.r2Key,
        skill.createdAt,
      )
      .run();
    return skill;
  }

  /**
   * List every enterprise skill (`owner_email IS NULL`), most recently added first --
   * `GET /api/admin/skills`'s own listing (US-10's "an enterprise skill is visible to
   * everyone" acceptance criterion, from an admin's management perspective).
   *
   * @returns Every enterprise skill.
   */
  async listEnterprise(): Promise<Skill[]> {
    const { results } = await this.database
      .prepare(
        `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
         FROM skills WHERE owner_email IS NULL ORDER BY created_at DESC`,
      )
      .all<SkillRow>();
    return results.map(toSkill);
  }

  /**
   * List one identity's own personal skills, most recently added first --
   * `GET /api/skills`'s own listing.
   *
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The identity's own personal skills -- never another user's.
   */
  async listPersonal(ownerEmail: string): Promise<Skill[]> {
    const { results } = await this.database
      .prepare(
        `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
         FROM skills WHERE owner_email = ? ORDER BY created_at DESC`,
      )
      .bind(ownerEmail)
      .all<SkillRow>();
    return results.map(toSkill);
  }

  /**
   * Look up a skill by name within one scope -- used before creating a new skill to reject a
   * name that would otherwise be silently ignored by `agents/skills`'s own `SkillRegistry`
   * (which keeps only the first-registered skill for a duplicate name and logs a warning,
   * Spike D Section 6, never an error) with a clear `422` instead.
   *
   * @param ownerEmail The scope to check: `null` for enterprise, an identity for personal.
   * @param name The candidate name (`./validation.ts`'s `sanitizeSkillName()`).
   * @returns The existing skill with this name in this scope, or `null` if none exists.
   */
  async findByNameInScope(
    ownerEmail: string | null,
    name: string,
  ): Promise<Skill | null> {
    const row =
      ownerEmail === null
        ? await this.database
            .prepare(
              `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
               FROM skills WHERE owner_email IS NULL AND name = ? LIMIT 1`,
            )
            .bind(name)
            .first<SkillRow>()
        : await this.database
            .prepare(
              `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
               FROM skills WHERE owner_email = ? AND name = ? LIMIT 1`,
            )
            .bind(ownerEmail, name)
            .first<SkillRow>();
    return row === null ? null : toSkill(row);
  }

  /**
   * Look up a personal skill, scoped to its owner in the same query rather than checked
   * afterward -- a skill id that exists but belongs to a different owner is indistinguishable
   * from one that does not exist at all, mirroring `../chats/repository.ts`'s `findOwned()`
   * "scope inside the query, not afterward" discipline (`DELETE /api/skills/:id`'s `404`, not
   * `403`).
   *
   * @param id Skill id from the request path.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns The skill if it exists and is owned by `ownerEmail`, otherwise `null`.
   */
  async findPersonalOwned(
    id: string,
    ownerEmail: string,
  ): Promise<Skill | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
         FROM skills WHERE id = ? AND owner_email = ? LIMIT 1`,
      )
      .bind(id, ownerEmail)
      .first<SkillRow>();
    return row === null ? null : toSkill(row);
  }

  /**
   * Look up an enterprise skill by id (`owner_email IS NULL`) -- `DELETE /api/admin/skills/:id`'s
   * own lookup, already gated by `requireAdmin()` (`../middleware/require-admin.ts`) at the
   * route level, so this only needs to confirm the id is actually an enterprise skill.
   *
   * @param id Skill id from the request path.
   * @returns The enterprise skill, or `null` if no such skill exists.
   */
  async findEnterprise(id: string): Promise<Skill | null> {
    const row = await this.database
      .prepare(
        `SELECT id, owner_email, name, source_type, source_ref, r2_key, created_at
         FROM skills WHERE id = ? AND owner_email IS NULL LIMIT 1`,
      )
      .bind(id)
      .first<SkillRow>();
    return row === null ? null : toSkill(row);
  }

  /**
   * Remove a personal skill's row, scoped to its owner -- defense in depth alongside the
   * route's own {@link findPersonalOwned} check, mirroring `../chats/repository.ts`'s
   * `remove()`.
   *
   * @param id Skill id to remove.
   * @param ownerEmail Verified Cloudflare Access identity making the request.
   * @returns Whether a row was actually deleted.
   */
  async removePersonal(id: string, ownerEmail: string): Promise<boolean> {
    const result = await this.database
      .prepare(`DELETE FROM skills WHERE id = ? AND owner_email = ?`)
      .bind(id, ownerEmail)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Remove an enterprise skill's row.
   *
   * @param id Skill id to remove.
   * @returns Whether a row was actually deleted.
   */
  async removeEnterprise(id: string): Promise<boolean> {
    const result = await this.database
      .prepare(`DELETE FROM skills WHERE id = ? AND owner_email IS NULL`)
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }
}
