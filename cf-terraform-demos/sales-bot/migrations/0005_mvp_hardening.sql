-- Phase 5 — explicit retention policy and indexes for bounded operational reads.
--
-- Retention is configuration, not a hard-coded deletion schedule: an administrator can review and
-- change the interval before a scheduled cleanup implementation is enabled.

PRAGMA foreign_keys = ON;

CREATE TABLE retention_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  conversation_retention_days INTEGER NOT NULL CHECK (conversation_retention_days BETWEEN 30 AND 3650),
  audit_retention_days INTEGER NOT NULL CHECK (audit_retention_days BETWEEN 30 AND 3650),
  updated_at TEXT NOT NULL
);
INSERT INTO retention_configuration (id, conversation_retention_days, audit_retention_days, updated_at)
VALUES (1, 365, 730, CURRENT_TIMESTAMP);

CREATE INDEX idx_escalations_dashboard ON escalations (product_id, status, opened_at);
CREATE INDEX idx_audit_events_filters ON audit_events (action, resource, correlation_id, created_at DESC);

CREATE TABLE rate_limit_windows (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0)
);
CREATE INDEX idx_rate_limit_windows_start ON rate_limit_windows (window_start);
