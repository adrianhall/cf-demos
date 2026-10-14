-- Record which composition surface initiated each audited mutation.
ALTER TABLE audit_events ADD COLUMN channel TEXT NOT NULL DEFAULT 'api'
  CHECK (channel IN ('api', 'chat', 'mcp'));

CREATE INDEX audit_channel ON audit_events (channel, occurred_at DESC, id);
