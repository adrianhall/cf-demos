-- Ignite CRM — sales workflow: pipeline, deals, activities, contact next actions.
--
-- Seeds the one fixed review pipeline (reference data the application cannot run without) and the
-- `crm.assign` permission. Sample deals and activities are local-only (migrations/seed).

-- ---------------------------------------------------------------------------------------------
-- RBAC: reassigning a record's owner to someone else is a manager/owner action.
-- ---------------------------------------------------------------------------------------------

-- Mirrors SEED_ROLE_PERMISSIONS in src/shared/permissions.ts.
INSERT INTO role_permissions (role_id, permission) VALUES
  ('owner', 'crm.assign'),
  ('manager', 'crm.assign');

-- ---------------------------------------------------------------------------------------------
-- Pipeline configuration (fixed in release one; no editing UI)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE pipelines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE pipeline_stages (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines (id),
  key         TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
  label       TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  position    INTEGER NOT NULL CHECK (position >= 1),
  UNIQUE (pipeline_id, key),
  UNIQUE (pipeline_id, position)
) STRICT;

INSERT INTO pipelines (id, name, created_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Sales pipeline', '2026-10-01T00:00:00.000Z');

INSERT INTO pipeline_stages (id, pipeline_id, key, label, position) VALUES
  ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000001', 'lead', 'Lead', 1),
  ('10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000001', 'qualified', 'Qualified', 2),
  ('10000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000001', 'proposal', 'Proposal', 3),
  ('10000000-0000-4000-8000-000000000014', '10000000-0000-4000-8000-000000000001', 'negotiation', 'Negotiation', 4);

-- ---------------------------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------------------------

CREATE TABLE deals (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  company_id          TEXT REFERENCES companies (id),
  -- Independent of the company's primary contact: the person this deal is sold to.
  primary_contact_id  TEXT NOT NULL REFERENCES contacts (id),
  owner_id            TEXT NOT NULL REFERENCES users (id),
  pipeline_id         TEXT NOT NULL REFERENCES pipelines (id),
  stage_id            TEXT NOT NULL REFERENCES pipeline_stages (id),
  status              TEXT NOT NULL CHECK (status IN ('pending', 'won', 'lost')),
  -- Display-only free text; never parsed or audited verbatim.
  status_line         TEXT CHECK (status_line IS NULL OR length(status_line) <= 160),
  next_action_text    TEXT CHECK (next_action_text IS NULL OR length(next_action_text) BETWEEN 1 AND 140),
  next_action_date    TEXT,
  amount_minor        INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  expected_close_date TEXT,
  closed_at           TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  -- A next action is a pair, and only an open deal has one.
  CHECK ((next_action_text IS NULL) = (next_action_date IS NULL)),
  CHECK (status = 'pending' OR next_action_text IS NULL),
  -- A closed deal records when it closed; an open one has not.
  CHECK ((status = 'pending') = (closed_at IS NULL))
) STRICT;

CREATE INDEX deals_list ON deals (lower(title), id) WHERE deleted_at IS NULL;
CREATE INDEX deals_actions ON deals (owner_id, status, next_action_date) WHERE deleted_at IS NULL;
CREATE INDEX deals_pipeline ON deals (pipeline_id, stage_id, status) WHERE deleted_at IS NULL;
CREATE INDEX deals_contact ON deals (primary_contact_id) WHERE deleted_at IS NULL;
CREATE INDEX deals_company ON deals (company_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Activities: calls and meetings, written once and linked to many contacts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE activities (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('call', 'meeting')),
  subject          TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  summary          TEXT CHECK (summary IS NULL OR length(summary) <= 4000),
  occurred_at      TEXT NOT NULL,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
  author_id        TEXT NOT NULL REFERENCES users (id),
  company_id       TEXT REFERENCES companies (id),
  deal_id          TEXT REFERENCES deals (id),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
) STRICT;

CREATE INDEX activities_recent ON activities (occurred_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX activities_company ON activities (company_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX activities_deal ON activities (deal_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX activities_author ON activities (author_id);

CREATE TABLE activity_contacts (
  activity_id TEXT NOT NULL REFERENCES activities (id),
  contact_id  TEXT NOT NULL REFERENCES contacts (id),
  PRIMARY KEY (activity_id, contact_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX activity_contacts_contact ON activity_contacts (contact_id, activity_id);

-- ---------------------------------------------------------------------------------------------
-- Contact next actions ("one next action per contact", OnePageCRM's Action Stream)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE follow_ups (
  id           TEXT PRIMARY KEY,
  contact_id   TEXT NOT NULL REFERENCES contacts (id),
  assignee_id  TEXT NOT NULL REFERENCES users (id),
  text         TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 140),
  -- NULL means "as soon as possible", which sorts ahead of every dated action.
  due_date     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('open', 'done')),
  completed_at TEXT,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
) STRICT;

-- At most one open next action per contact; completed ones remain as history.
CREATE UNIQUE INDEX follow_ups_open_contact ON follow_ups (contact_id) WHERE status = 'open';
CREATE INDEX follow_ups_actions ON follow_ups (assignee_id, status, due_date);
