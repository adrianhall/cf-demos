-- Read-only anonymous sharing (docs/09-ARCHITECT.md Phase 3, Decisions #3). `token_digest` is a
-- SHA-256 hex digest of the share token -- the raw token itself is never persisted anywhere,
-- fixing CF-Architect's original plaintext-token storage bug. A diagram has at most one active
-- (unrevoked) share at a time: creating a new share revokes any prior active row for the same
-- `diagram_id` rather than deleting it, so `revoked_at` also doubles as a lightweight audit
-- trail of past share links.
CREATE TABLE diagram_shares (
  token_digest TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX diagram_shares_diagram_id_idx ON diagram_shares (diagram_id);
