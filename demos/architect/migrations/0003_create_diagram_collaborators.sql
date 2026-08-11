-- Authenticated edit-collaboration (docs/09C-COLLABORATIVE-EDITING.md). Distinct from
-- diagram_shares (docs/09-ARCHITECT.md Phase 3): a share link grants anonymous, read-only,
-- unauthenticated access; a collaborator row grants a specific, already-known Access identity
-- full edit access. collaborator_email must already exist in `users` (i.e. that identity has
-- signed in through this Access application at least once) -- enforced by the repository, not a
-- foreign key, since `users` has no enforced-unique constraint beyond its own primary key that
-- SQLite could reference cleanly alongside diagram_id's own lack of a `diagrams` FK (Demo 9 never
-- added one there either, for the same D1/SQLite-pragma reasons -- see that migration).
CREATE TABLE diagram_collaborators (
  diagram_id TEXT NOT NULL,
  collaborator_email TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (diagram_id, collaborator_email)
);

CREATE INDEX diagram_collaborators_email_idx ON diagram_collaborators (collaborator_email);
