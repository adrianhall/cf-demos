-- Ignite CRM — foundation schema: permissions, companies/contacts, audit, idempotency.
--
-- One migration stream for the Data Worker's single D1 database. Table families are kept separate
-- by name prefix-free convention (users/roles/... for Permissions; companies/contacts for CRM;
-- audit_events/idempotency_records shared). Every table is STRICT and every timestamp is UTC
-- ISO-8601 text. Seeds here are limited to the fixed RBAC vocabulary; sample users and records are
-- local-only (migrations/seed/local.sql).

-- ---------------------------------------------------------------------------------------------
-- Permissions module
-- ---------------------------------------------------------------------------------------------

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  status       TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE roles (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
) STRICT;

CREATE TABLE role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles (id),
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) STRICT, WITHOUT ROWID;

CREATE TABLE user_roles (
  user_id    TEXT NOT NULL REFERENCES users (id),
  role_id    TEXT NOT NULL REFERENCES roles (id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
) STRICT, WITHOUT ROWID;

INSERT INTO roles (id, label) VALUES
  ('owner', 'Owner'),
  ('manager', 'Manager'),
  ('sales', 'Sales representative'),
  ('delivery', 'Delivery contributor'),
  ('read-only', 'Read-only');

-- Mirrors SEED_ROLE_PERMISSIONS in src/shared/permissions.ts; a Workers-runtime test asserts the
-- two match.
INSERT INTO role_permissions (role_id, permission) VALUES
  ('owner', 'users.manage'), ('owner', 'roles.assign'), ('owner', 'audit.read'),
  ('owner', 'crm.read'), ('owner', 'crm.write'), ('owner', 'crm.delete'), ('owner', 'deal.convert'),
  ('owner', 'project.read'), ('owner', 'project.write'), ('owner', 'project.manage'),
  ('owner', 'note.read'), ('owner', 'note.write'), ('owner', 'note.manage'), ('owner', 'report.read'),
  ('manager', 'audit.read'),
  ('manager', 'crm.read'), ('manager', 'crm.write'), ('manager', 'crm.delete'), ('manager', 'deal.convert'),
  ('manager', 'project.read'), ('manager', 'project.write'), ('manager', 'project.manage'),
  ('manager', 'note.read'), ('manager', 'note.write'), ('manager', 'note.manage'), ('manager', 'report.read'),
  ('sales', 'crm.read'), ('sales', 'crm.write'), ('sales', 'deal.convert'),
  ('sales', 'project.read'), ('sales', 'note.read'), ('sales', 'note.write'), ('sales', 'report.read'),
  ('delivery', 'crm.read'), ('delivery', 'project.read'), ('delivery', 'project.write'),
  ('delivery', 'note.read'), ('delivery', 'note.write'), ('delivery', 'report.read'),
  ('read-only', 'crm.read'), ('read-only', 'project.read'), ('read-only', 'note.read'),
  ('read-only', 'report.read');

-- ---------------------------------------------------------------------------------------------
-- CRM module: companies and contacts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE companies (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address             TEXT,
  stock_symbol        TEXT,
  companies_house_url TEXT,
  -- Points into this company's own contacts. Not a declared foreign key because contacts also
  -- reference companies; the application keeps it honest (reassigned/cleared on contact delete).
  primary_contact_id  TEXT,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by          TEXT NOT NULL REFERENCES users (id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
) STRICT;

-- Company reuse during contact creation matches names case-insensitively, so two live companies
-- may never share a name differing only in case. Soft-deleted rows are excluded.
CREATE UNIQUE INDEX companies_live_name ON companies (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX companies_list ON companies (lower(name), id) WHERE deleted_at IS NULL;

CREATE TABLE contacts (
  id           TEXT PRIMARY KEY,
  first_name   TEXT,
  last_name    TEXT,
  -- Denormalised sort/search key: "first last", or the company name for a company-only lead.
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 201),
  email        TEXT,
  phone        TEXT,
  job_title    TEXT,
  company_id   TEXT REFERENCES companies (id),
  owner_id     TEXT NOT NULL REFERENCES users (id),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
) STRICT;

CREATE INDEX contacts_list ON contacts (lower(display_name), id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_company ON contacts (company_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX contacts_recent ON contacts (updated_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Shared: audit events and idempotency records
-- ---------------------------------------------------------------------------------------------

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  module        TEXT NOT NULL CHECK (module IN ('crm', 'projects', 'notes', 'permissions')),
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_id      TEXT NOT NULL REFERENCES users (id),
  request_id    TEXT NOT NULL,
  -- Safe before/after metadata only: never note bodies, tokens, or free-text status lines.
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at   TEXT NOT NULL
) STRICT;

CREATE INDEX audit_entity ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_recent ON audit_events (occurred_at DESC, id);

CREATE TABLE idempotency_records (
  actor_id        TEXT NOT NULL REFERENCES users (id),
  operation       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  result_json     TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX idempotency_expiry ON idempotency_records (created_at);

-- ---------------------------------------------------------------------------------------------
-- Transaction guard
-- ---------------------------------------------------------------------------------------------
--
-- D1 has no interactive transactions: a `batch()` is atomic, but its statements cannot branch on
-- each other's results. A compare-and-swap therefore needs a statement that *fails the batch* when
-- a precondition does not hold. Inserting a count into this view does exactly that: an INSTEAD OF
-- trigger raises — aborting and rolling back the whole batch — when the count is below 1, with a
-- message naming the service error code to report; otherwise the row is discarded. RAISE needs a
-- literal message, hence one trigger per reportable reason. See
-- src/data-worker/infrastructure/d1/d1-port.ts.
CREATE VIEW tx_guard AS SELECT 1 AS changed, 'CONFLICT' AS reason;

CREATE TRIGGER tx_guard_conflict INSTEAD OF INSERT ON tx_guard
WHEN NEW.changed < 1 AND NEW.reason = 'CONFLICT'
BEGIN
  SELECT RAISE(ABORT, 'IGNITE_TX_GUARD:CONFLICT');
END;

CREATE TRIGGER tx_guard_version INSTEAD OF INSERT ON tx_guard
WHEN NEW.changed < 1 AND NEW.reason = 'VERSION_MISMATCH'
BEGIN
  SELECT RAISE(ABORT, 'IGNITE_TX_GUARD:VERSION_MISMATCH');
END;

CREATE TRIGGER tx_guard_not_found INSTEAD OF INSERT ON tx_guard
WHEN NEW.changed < 1 AND NEW.reason = 'NOT_FOUND'
BEGIN
  SELECT RAISE(ABORT, 'IGNITE_TX_GUARD:NOT_FOUND');
END;
