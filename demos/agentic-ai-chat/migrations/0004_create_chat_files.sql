-- Agent-generated files attached to a chat (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 9, US-8).
-- The only writer is ChatAgent's own `writeMarkdown` tool (`src/worker/agent/tools/write-markdown.ts`),
-- and only after a confirmed R2 write (`src/worker/files/storage.ts`) -- see that module's own
-- ordering comment for why the R2 write always happens first, with this row inserted only
-- afterward, and deleted (compensated) if this insert itself then fails.
--
-- `correlation_id` resolves docs/06-AGENTIC-CHAT.md Section 15's own open question ("exact
-- correlation key between a chat_files row and the chat_usage row(s) that produced it"): it is
-- the same per-turn UUID `ChatAgent.onChatMessage()` mints and attaches to `chat_usage.correlation_id`
-- (Phase 6, Section 6.6) -- every file a turn's tool call writes is stamped with that same turn's
-- id, so a later phase's per-file cost export (Phase 12) can join `chat_files` directly to the
-- exact `chat_usage` row that produced it, not an approximation inferred from timestamps.
CREATE TABLE chat_files (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX chat_files_chat_id_idx ON chat_files (chat_id);
CREATE INDEX chat_files_correlation_id_idx ON chat_files (correlation_id);
