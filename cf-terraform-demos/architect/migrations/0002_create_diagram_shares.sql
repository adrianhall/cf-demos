-- Read-only anonymous sharing.
--
-- The primary key is a SHA-256 hex digest of the share token, and the raw token itself is never
-- written here, into the `SHARES` KV namespace, or into a log. A share token is a bearer
-- capability -- whoever holds it may read the diagram, with no identity at all -- so storing one
-- would mean a copy of the database, or a leaked log line, handed out every live link. The
-- consequence is deliberate and visible in the API: once a link has been shown to its owner the
-- server cannot reproduce it, so share status reports only *that* a link is active. An owner who
-- has lost theirs mints a new one, which revokes the old.
--
-- A diagram has at most one active share at a time. Creating one revokes the previous row rather
-- than deleting it, so `revoked_at` doubles as a lightweight record that a link once existed.
--
-- There are no foreign keys here, for the same reason as in
-- `0001_create_diagrams_and_users.sql`: D1 does not guarantee the `PRAGMA foreign_keys` handling
-- a cascade would need, and the application tier owns every delete that would cascade -- the
-- diagram delete use case revokes every share for the diagram it just removed.
CREATE TABLE diagram_shares (
  -- SHA-256 hex digest of the share token. The token's only stored form.
  token_digest TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- NULL while the share is active. Set, never deleted, when the link is revoked or rotated.
  revoked_at TEXT
);

-- Both owner-facing queries -- "does this diagram have an active link" and the delete cascade --
-- filter on `diagram_id`. Indexing it keeps them from scanning every share in the table.
CREATE INDEX diagram_shares_diagram_id_idx ON diagram_shares (diagram_id);
