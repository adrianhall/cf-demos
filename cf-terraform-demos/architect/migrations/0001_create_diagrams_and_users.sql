-- The one durable copy of a diagram. Even once a live editing session exists, this table stays
-- authoritative: the Durable Object that coordinates those sessions deliberately keeps no durable
-- graph of its own, because two independently persisted copies of one diagram can silently
-- disagree and nothing else in this demo has to reason about that failure mode.
--
-- There are no foreign keys anywhere in this schema. D1 requires `PRAGMA foreign_keys` handling
-- that the migration path does not guarantee, and the integrity these constraints would buy is
-- already enforced in the application tier, which owns every delete that would cascade.
CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  -- Verified Cloudflare Access identity (the JWT `email` claim) that owns this row. Never
  -- supplied by the client.
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  -- The serialised node/edge graph. Opaque to SQL on purpose: nothing queries inside it, and
  -- validation belongs to the domain tier where every transport enforces the same rules.
  graph_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every owner-scoped query filters on `owner_email`, which is also the predicate that enforces
-- per-user isolation. Indexing it keeps that filter from scanning the shared table.
CREATE INDEX diagrams_owner_email_idx ON diagrams (owner_email);

-- A lightweight directory only, upserted as a best-effort side effect of an authenticated
-- request. It is never consulted for authorization.
--
-- Note the absence of an `is_admin` column, which is the point rather than an omission: exactly
-- one identity is the administrator, named by the operator-configured ADMIN_EMAIL Worker
-- variable. There is no role column, no promote/demote flow and no first-user-wins bootstrap, so
-- an attacker who can write to this table still cannot grant themselves administrative access.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
