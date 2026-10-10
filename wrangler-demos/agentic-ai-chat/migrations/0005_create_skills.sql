-- Personal and enterprise skills (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 11, US-10). This
-- table is a *management catalog* only -- it lets `src/worker/routes/skills.ts`/`admin.ts` list
-- and delete a skill and clean up its R2 object -- never what `ChatAgent` actually reads at
-- turn time. The model-visible catalog is derived entirely from R2 by `agents/skills`'s own
-- `r2()` source (`src/worker/skills/registry.ts`), which discovers a skill by scanning for
-- `{prefix}{directory}/SKILL.md` objects; this table's `r2_key` column is that same directory's
-- key, not the `SKILL.md` object key itself (`src/worker/skills/storage.ts`'s
-- `skillMarkdownKey()` derives the latter when needed).
--
-- `owner_email` is nullable: `NULL` means an enterprise skill (added by an admin, visible to
-- every chat), a real email means a personal skill (added by its owner, visible only to that
-- owner's own chats) -- mirrors `chat_files.chat_id`'s "this column's value decides visibility"
-- shape, applied to a two-way scope instead of a single owning chat.
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'url')),
  source_ref TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX skills_owner_email_idx ON skills (owner_email);
