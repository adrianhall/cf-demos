-- One row per review run (docs/07-PR-REVIEW-AGENT.md, "Data Model"). `id` is a
-- `crypto.randomUUID()` minted by the Worker when a webhook or manual trigger is accepted, not a
-- database-generated value, so every foreign key elsewhere in this migration references it as
-- plain TEXT rather than an autoincrement integer.
CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  pr_title TEXT NOT NULL,
  pr_author TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('webhook', 'manual')),
  triggered_by_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  diff_truncated INTEGER NOT NULL DEFAULT 0,
  changed_file_count INTEGER NOT NULL DEFAULT 0,
  comment_url TEXT,
  -- The run's canonical Markdown report (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And
  -- Comment Posting" -- "the full report (stored in D1 ... and what the UI's report page
  -- renders)"). Not one of the Data Model table's own "Notable columns" -- that list is
  -- explicitly non-exhaustive -- but there is nowhere else in this schema to durably persist it,
  -- so `merge-and-post-comment` (`../src/worker/workflows/ReviewPipelineWorkflow.ts`) writes it
  -- here alongside `comment_url`.
  full_report TEXT,
  error_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE (provider, repo_full_name, pr_number, head_sha)
);

-- Idempotency guard against a provider's webhook retry starting a second review for a delivery
-- already accepted (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration"). `id` is the
-- composite `"<provider>:<deliveryId>"` key the Worker builds itself, not a separate surrogate
-- key.
CREATE TABLE review_webhook_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES review_runs (id),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-reviewer execution record, upserted -- never a plain INSERT -- by its owning Workflow step
-- (docs/07-PR-REVIEW-AGENT.md, "Review Orchestration"): a retried step must be able to write
-- this row more than once without conflicting or duplicating, hence the UNIQUE constraint used
-- as an upsert key rather than an error to avoid.
CREATE TABLE review_reviewers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES review_runs (id),
  role TEXT NOT NULL CHECK (
    role IN ('architecture', 'security', 'code-quality', 'accessibility')
  ),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'skipped', 'error')),
  skipped_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_detail TEXT,
  ai_gateway_log_id TEXT,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_source TEXT NOT NULL DEFAULT 'pending' CHECK (cost_source IN ('pending', 'gateway')),
  -- This reviewer's full raw prose output, for the full report's per-reviewer collapsible
  -- section (docs/07-PR-REVIEW-AGENT.md, "Report Assembly And Comment Posting"). Not one of the
  -- Data Model table's own "Notable columns" -- that list is explicitly non-exhaustive -- but
  -- the `review:<role>` Workflow step (`../src/worker/workflows/ReviewPipelineWorkflow.ts`) must
  -- persist this text *inside its own step* (so it never outlives that step as an in-memory
  -- variable) and there is nowhere else in this schema to put it. NULL for a skipped reviewer.
  raw_output TEXT,
  UNIQUE (run_id, role)
);

-- Merged findings across every reviewer that produced output for a run (docs/07-PR-REVIEW-AGENT.md,
-- "Reviewer Personas And Structured Findings" for the merge/dedupe rule that produces these
-- rows).
CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES review_runs (id),
  finding_ref TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  category TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  finding TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  merged_from TEXT
);

CREATE INDEX idx_review_reviewers_run_id ON review_reviewers (run_id);
CREATE INDEX idx_review_findings_run_id ON review_findings (run_id);
CREATE INDEX idx_review_runs_created_at ON review_runs (created_at);
