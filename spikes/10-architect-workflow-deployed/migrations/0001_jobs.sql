CREATE TABLE IF NOT EXISTS architecture_jobs (
  id TEXT PRIMARY KEY,
  fixture TEXT NOT NULL,
  status TEXT NOT NULL,
  proposal_key TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
