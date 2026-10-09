-- Authenticated edit collaboration. Distinct from `diagram_shares`
-- (`0002_create_diagram_shares.sql`), and the distinction is the whole point of a second table: a
-- share link grants anonymous, read-only, unauthenticated access to whoever holds the token, while
-- a collaborator row grants one specific, already-known Cloudflare Access identity full edit
-- access. Collapsing the two would mean one revocation story for two different questions.
--
-- `collaborator_email` must already exist in `users` -- that is, the person has signed in through
-- this Access application at least once. That rule is enforced in the application tier
-- (`src/worker/application/collaborator-service.ts`), not by a foreign key, for the same reason
-- the rest of this schema has none: D1 does not guarantee the `PRAGMA foreign_keys` handling a
-- constraint would need, and the application already owns every delete that would cascade. Putting
-- the rule above storage also keeps its refusal a deliberate, user-facing message ("that person
-- needs to sign in to Architect once first") rather than an opaque constraint violation.
--
-- There is no role column. Every collaborator may edit the whole diagram; "let somebody look
-- without editing" is already answered by the anonymous read-only link, and a second,
-- authenticated viewer role would be a third sharing concept with no new teaching value.
CREATE TABLE diagram_collaborators (
  diagram_id TEXT NOT NULL,
  -- Verified Cloudflare Access identity granted edit access. Never a free-text invitation: the
  -- application refuses an email that has never authenticated here.
  collaborator_email TEXT NOT NULL,
  -- The owner's email at the time of the grant, kept purely as an audit trail. No route reads it
  -- back; it costs one column and answers "who let this person in" when somebody asks later.
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  -- The composite key is what makes adding an existing collaborator idempotent rather than an
  -- error: there is exactly one row per (diagram, identity) pair by construction, so the
  -- application can re-read the existing row instead of making the client special-case "already a
  -- collaborator".
  PRIMARY KEY (diagram_id, collaborator_email)
);

-- The composite primary key already indexes `diagram_id` as its leading column, which serves "who
-- collaborates on this diagram" and the delete cascade. This second index serves the query the
-- primary key cannot: "which diagrams is this identity a collaborator on", which the dashboard's
-- "Shared with me" section asks on every load and which would otherwise scan the whole table.
CREATE INDEX diagram_collaborators_email_idx ON diagram_collaborators (collaborator_email);
