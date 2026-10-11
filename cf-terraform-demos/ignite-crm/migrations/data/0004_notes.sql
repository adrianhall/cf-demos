-- Ignite CRM — multi-linked Markdown notes and full-text search.
--
-- One canonical note links to many contacts, companies, deals, and projects (specification §6.1,
-- §7.2). The note, its links, audit, and idempotency rows commit in one D1 write set, and the FTS5
-- index is maintained by triggers inside that same write, so a rolled-back note is never
-- searchable. Raw Markdown is stored; rendered HTML never is. Sample notes are local-only
-- (migrations/seed).

-- ---------------------------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------------------------

-- A rowid table (not WITHOUT ROWID) because the FTS5 external-content index keys on `rowid`.
CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 64 KiB of UTF-8, measured in bytes after the application normalises newlines.
  markdown       TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) BETWEEN 1 AND 65536),
  author_id      TEXT NOT NULL REFERENCES users (id),
  last_edited_by TEXT NOT NULL REFERENCES users (id),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
) STRICT;

CREATE INDEX notes_recent ON notes (updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX notes_author ON notes (author_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Typed links. The target is polymorphic, so it has no foreign key: the application validates
-- each new target against the same snapshot and re-checks it with a commit-time guard. A target's
-- later soft deletion does not remove the link; the note shows it as a tombstone.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE note_links (
  note_id     TEXT NOT NULL REFERENCES notes (id),
  target_type TEXT NOT NULL CHECK (target_type IN ('contact', 'company', 'deal', 'project')),
  target_id   TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, target_type, target_id)
) STRICT, WITHOUT ROWID;

-- "Notes about this record" reads the link table first, without touching FTS.
CREATE INDEX note_links_target ON note_links (target_type, target_id, note_id);

-- ---------------------------------------------------------------------------------------------
-- Full-text search over title and body (D1 supports FTS5). External content: the index stores
-- tokens only, and `notes` remains the single copy of the text. `remove_diacritics 2` lets "cafe"
-- find "café". Only live notes are indexed; soft deletion removes a note from the index.
-- ---------------------------------------------------------------------------------------------

CREATE VIRTUAL TABLE notes_fts USING fts5 (
  title,
  markdown,
  content = 'notes',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO notes_fts (rowid, title, markdown) VALUES (NEW.rowid, NEW.title, NEW.markdown);
END;

-- One trigger with two conditional statements, so the old tokens are always removed before the
-- new ones are added (SQLite does not guarantee the firing order of separate triggers).
CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes
BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, markdown)
    SELECT 'delete', OLD.rowid, OLD.title, OLD.markdown WHERE OLD.deleted_at IS NULL;
  INSERT INTO notes_fts (rowid, title, markdown)
    SELECT NEW.rowid, NEW.title, NEW.markdown WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes
WHEN OLD.deleted_at IS NULL
BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, title, markdown)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.markdown);
END;
