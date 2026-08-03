CREATE TABLE users (
  email TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
);

-- `title`/`route` are nullable: a chat has neither until Phase 3 (auto-title after the first
-- completed turn) and Phase 4 (route selection) exist. Phase 2 only needs `id`/`owner_email`/
-- `created_at`/`updated_at` to instance a Durable Object per chat and enforce ownership.
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT,
  route TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX chats_owner_email_idx ON chats (owner_email);
