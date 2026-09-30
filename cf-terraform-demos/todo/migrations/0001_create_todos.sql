-- Every user's tasks share one table, distinguished only by `user_id`. That is deliberate: it is
-- how a real multi-tenant application stores data, and it makes the point that isolation is
-- enforced by the query predicate in src/worker/infrastructure/d1-todo-repository.ts rather than by
-- giving each user separate storage.
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  -- Verified Cloudflare Access identity (the JWT `email` claim) that owns this row. Never supplied
  -- by the client; see src/worker/routes/identity.ts.
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- SQLite has no boolean type. The CHECK keeps the column to exactly 0/1 so the repository's
  -- `completed = 1` predicate and its `completed === 1` mapping cannot be defeated by an
  -- unexpected value reaching the database through some future code path.
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every query in the repository filters by `user_id`, and the list query then orders by
-- `created_at DESC`. A composite index in that order lets SQLite satisfy both the filter and the
-- sort from the index alone, instead of scanning the shared table and sorting the result.
CREATE INDEX IF NOT EXISTS todos_user_created_idx ON todos (user_id, created_at DESC);
