CREATE TABLE IF NOT EXISTS architecture_jobs (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  fixture TEXT NOT NULL,
  status TEXT NOT NULL,
  proposal_key TEXT,
  failure_reason TEXT
);
