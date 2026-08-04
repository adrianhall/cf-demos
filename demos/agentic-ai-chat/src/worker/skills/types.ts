/** How a skill's content was originally provided (docs/06-AGENTIC-CHAT.md Section 6.4, Phase
 * 11, US-10) -- kept only for the management UI/catalog display; the R2-stored `SKILL.md`
 * content is identical either way (`./validation.ts`'s `buildSkillMarkdown()`). */
export type SkillSourceType = "upload" | "url";

/**
 * One `skills` D1 row: a personal or enterprise skill's management metadata
 * (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 11, US-10). This is a catalog entry for
 * `src/worker/routes/skills.ts`/`admin.ts` to list and delete -- the model-visible catalog
 * `ChatAgent` actually reads at turn time comes entirely from R2 via `./registry.ts`'s
 * `buildSkillRegistry()`, never from this table directly.
 */
export interface Skill {
  /** Server-generated identifier -- also the directory segment `r2Key` embeds
   * (`./storage.ts`'s `skillDirectoryKey()`). */
  readonly id: string;
  /** The owning identity, or `null` for an enterprise skill (visible to every chat). A
   * non-`null` value is this skill's owner -- the only identity whose chats may activate it
   * (US-10's "a personal skill is invisible to other users" acceptance criterion). */
  readonly ownerEmail: string | null;
  /** The skill's display name -- also the exact `name` value written into the R2-stored
   * `SKILL.md`'s YAML frontmatter, and so the literal string a model must pass to
   * `activate_skill` to use it. */
  readonly name: string;
  /** How this skill's content was originally provided. */
  readonly sourceType: SkillSourceType;
  /** The source URL this skill's content was fetched from, or `null` for an uploaded skill. */
  readonly sourceRef: string | null;
  /** This skill's R2 **directory** key (for example `skills/enterprise/<id>` or
   * `skills/personal/<owner>/<id>`) -- not the `SKILL.md` object key itself. `./storage.ts`'s
   * `skillMarkdownKey()`/`deleteSkillDirectory()` both derive from this. */
  readonly r2Key: string;
  /** ISO 8601 timestamp this skill was added. */
  readonly createdAt: string;
}
