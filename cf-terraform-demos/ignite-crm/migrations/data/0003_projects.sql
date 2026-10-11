-- Ignite CRM — delivery: projects, tasks, and atomic won-deal conversion.
--
-- A won deal becomes at most one project in a single D1 write set (specification §7.1): the
-- project, its conversion record, the deal's back-link, audit, and idempotency rows commit together
-- or not at all. Sample projects and tasks are local-only (migrations/seed).

-- ---------------------------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------------------------

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description        TEXT CHECK (description IS NULL OR length(description) <= 4000),
  status             TEXT NOT NULL CHECK (status IN ('active', 'on_hold', 'completed', 'archived')),
  -- Immutable once set: the won deal this project delivers. NULL for a standalone project.
  source_deal_id     TEXT REFERENCES deals (id),
  company_id         TEXT REFERENCES companies (id),
  primary_contact_id TEXT REFERENCES contacts (id),
  lead_id            TEXT NOT NULL REFERENCES users (id),
  target_date        TEXT,
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
) STRICT;

-- A deal converts at most once, even under concurrent requests.
CREATE UNIQUE INDEX projects_source_deal ON projects (source_deal_id) WHERE source_deal_id IS NOT NULL;
CREATE INDEX projects_list ON projects (lower(name), id) WHERE deleted_at IS NULL;
CREATE INDEX projects_company ON projects (company_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_contact ON projects (primary_contact_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_lead ON projects (lead_id, status) WHERE deleted_at IS NULL;

-- The deal's back-link. SQLite adds a referencing column only with a NULL default, which is what a
-- not-yet-converted deal needs.
ALTER TABLE deals ADD COLUMN project_id TEXT REFERENCES projects (id);
CREATE UNIQUE INDEX deals_project ON deals (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Conversion record: operational evidence that a conversion happened, never a pending state.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE conversion_attempts (
  source_deal_id TEXT PRIMARY KEY REFERENCES deals (id),
  project_id     TEXT NOT NULL REFERENCES projects (id),
  actor_id       TEXT NOT NULL REFERENCES users (id),
  -- Always 'completed': the conversion is one transaction, so there is no pending or partial state.
  state          TEXT NOT NULL CHECK (state = 'completed'),
  created_at     TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------------------------
-- Tasks (fixed Linear-style statuses and priorities)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description  TEXT CHECK (description IS NULL OR length(description) <= 8000),
  status       TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
  priority     TEXT NOT NULL CHECK (priority IN ('no_priority', 'low', 'medium', 'high', 'urgent')),
  assignee_id  TEXT REFERENCES users (id),
  due_date     TEXT,
  -- Sparse ordering within a status column; ties break by id.
  position     INTEGER NOT NULL CHECK (position >= 0),
  created_by   TEXT NOT NULL REFERENCES users (id),
  completed_at TEXT,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  -- `done` records when; any other status has not completed.
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
) STRICT;

CREATE INDEX tasks_board ON tasks (project_id, status, position, id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_my_work ON tasks (assignee_id, status, due_date, id) WHERE deleted_at IS NULL;
