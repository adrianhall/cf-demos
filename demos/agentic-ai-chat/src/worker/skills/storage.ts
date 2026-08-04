/**
 * R2 persistence for personal/enterprise skills (docs/06-AGENTIC-CHAT.md Section 6.1/6.4, Phase
 * 11, US-10). Skills share the same `FILES` bucket agent-generated files already use
 * (Section 6.1 lists "agent-generated files; skill bundle content" as one R2 use, not two) --
 * namespaced under its own `skills/` prefix, entirely disjoint from `../files/storage.ts`'s
 * `chats/` prefix, so no separate bucket or Terraform resource is needed for this phase.
 */

/**
 * Build one skill's R2 **directory** key -- the prefix `agents/skills`'s `r2()` source scans
 * for a `SKILL.md` object directly underneath (`./registry.ts`), and the same prefix
 * {@link deleteSkillDirectory} removes everything under when a skill is deleted.
 *
 * An enterprise skill (`ownerEmail === null`) lives under a shared `skills/enterprise/` prefix,
 * visible to every chat's registry; a personal skill lives under a per-owner
 * `skills/personal/<ownerEmail>/` prefix, included only in that same owner's own registry
 * (`./registry.ts`'s `buildSkillRegistry()`) -- this is the actual mechanism enforcing US-10's
 * "a personal skill is invisible to other users" acceptance criterion, not an
 * application-level filter over one shared listing.
 *
 * `id` is always a server-generated UUID (`../routes/skills.ts`/`admin.ts`), never client
 * input, so this key can never be made to collide with or escape into another skill's own
 * directory -- mirrors `../files/storage.ts`'s `chatFileKey()`'s own rationale.
 *
 * @param ownerEmail The skill's owner, or `null` for an enterprise skill.
 * @param id The skill's own server-generated id.
 * @returns The R2 directory key this skill's `SKILL.md` (and any future resource files) live
 * under.
 */
export function skillDirectoryKey(
  ownerEmail: string | null,
  id: string,
): string {
  return ownerEmail === null
    ? `skills/enterprise/${id}`
    : `skills/personal/${ownerEmail}/${id}`;
}

/**
 * Build the `SKILL.md` object key inside one skill's own directory -- the exact filename
 * `agents/skills`'s `r2()` source requires (Spike D, Section 4).
 *
 * @param directoryKey A skill's own directory key ({@link skillDirectoryKey}).
 * @returns The `SKILL.md` object key.
 */
export function skillMarkdownKey(directoryKey: string): string {
  return `${directoryKey}/SKILL.md`;
}

/**
 * Write one skill's already-built `SKILL.md` content to R2. Always called **before** the
 * corresponding `skills` D1 row is inserted (`../skills/service.ts`), mirroring
 * `../files/storage.ts`'s own "R2 write before D1 insert" ordering (docs/06-AGENTIC-CHAT.md
 * Section 11).
 *
 * @param bucket R2 bucket binding (`FILES`).
 * @param directoryKey Destination directory ({@link skillDirectoryKey}).
 * @param markdown The skill's full `SKILL.md` content (`../skills/validation.ts`'s
 * `buildSkillMarkdown()`).
 */
export async function putSkillMarkdown(
  bucket: R2Bucket,
  directoryKey: string,
  markdown: string,
): Promise<void> {
  await bucket.put(skillMarkdownKey(directoryKey), markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
}

/**
 * Delete every object under one skill's own directory -- used both to compensate for a `skills`
 * D1 insert that fails after a successful R2 write (Section 11, mirroring
 * `../files/storage.ts`'s own compensation), and as the normal cleanup step when a skill is
 * deleted through `DELETE /api/skills/:id`/`DELETE /api/admin/skills/:id`. Lists with
 * pagination (`agents/skills`'s own `r2()` source does the same, Spike D Section 4's
 * `listAllObjects()`) so a skill with more than one page of resource files is still fully
 * removed, even though every skill this phase's own routes create today has exactly one object
 * (its `SKILL.md`).
 *
 * @param bucket R2 bucket binding (`FILES`).
 * @param directoryKey The skill's own directory key ({@link skillDirectoryKey}).
 */
export async function deleteSkillDirectory(
  bucket: R2Bucket,
  directoryKey: string,
): Promise<void> {
  const prefix = `${directoryKey}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  let truncated = true;
  while (truncated) {
    const listed = await bucket.list({ prefix, cursor });
    keys.push(...listed.objects.map((object) => object.key));
    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }
  if (keys.length > 0) {
    await bucket.delete(keys);
  }
}
