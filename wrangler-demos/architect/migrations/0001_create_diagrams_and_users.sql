CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  graph_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX diagrams_owner_email_idx ON diagrams (owner_email);

-- A lightweight directory only, upserted by the shared auth middleware on every authenticated
-- request (src/worker/middleware/upsert-user.ts). It is never consulted for authorization —
-- admin status is the operator-configured ADMIN_EMAIL Worker variable, not a column here.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
