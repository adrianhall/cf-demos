-- Phase 3 (docs/09-ARCHITECT.md) needs a stable, opaque identifier for one invitation that is
-- safe to hand to the browser for listing and revoking, without ever exposing the SHA-256
-- `token_digest` itself. The digest is a one-way hash of the raw token, so exposing it would not
-- let anyone recover the original capability — but there is still no legitimate reason for a
-- browser to receive it, and reusing it as a route/response identifier would blur the line
-- between "the diagram's owner sees an inert digest" and "the digest is meant to be handled by a
-- browser at all". `0001_initial.sql`'s `diagram_invites` table uses `token_digest` as its only
-- primary key, so recreate the table with a dedicated `id` primary key and demote `token_digest`
-- to a `UNIQUE` lookup column used only for server-side redemption.
CREATE TABLE diagram_invites_new (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  creator_email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by_email TEXT,
  revoked_at TEXT
);

INSERT INTO diagram_invites_new (
  id, token_digest, diagram_id, creator_email, expires_at, redeemed_at, redeemed_by_email, revoked_at
)
SELECT
  lower(hex(randomblob(16))),
  token_digest,
  diagram_id,
  creator_email,
  expires_at,
  redeemed_at,
  redeemed_by_email,
  revoked_at
FROM diagram_invites;

DROP TABLE diagram_invites;

ALTER TABLE diagram_invites_new RENAME TO diagram_invites;

CREATE INDEX idx_diagram_invites_diagram_id ON diagram_invites (diagram_id);
