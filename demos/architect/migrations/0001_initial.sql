CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE diagram_members (
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (diagram_id, email)
);

CREATE TABLE diagram_invites (
  token_digest TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  creator_email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by_email TEXT,
  revoked_at TEXT
);

CREATE TABLE diagram_shares (
  token_digest TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  r2_object_key TEXT NOT NULL,
  publication_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE architecture_jobs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL,
  requester_email TEXT NOT NULL,
  status TEXT NOT NULL,
  proposal_r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
