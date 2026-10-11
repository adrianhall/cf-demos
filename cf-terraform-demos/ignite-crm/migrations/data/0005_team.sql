-- Ignite CRM — team administration and the audit viewer.
--
-- No new tables: users, roles, user_roles, and audit_events already exist (0001). This migration adds
-- the indexes the team directory and the audit viewer's filters page through, and records who
-- granted each role. Role changes take effect on the next request because every authorization
-- decision reads user_roles and role_permissions afresh (no cache).

-- Reading the team directory is separate from managing it: managers see who is on the team (to
-- reassign coverage and filter the audit trail by person); only owners change membership, roles,
-- or status. Mirrors SEED_ROLE_PERMISSIONS in src/shared/permissions.ts.
INSERT INTO role_permissions (role_id, permission) VALUES
  ('owner', 'users.read'),
  ('manager', 'users.read');

-- Who granted a role. NULL for roles granted before this migration, on first sign-in, or by a seed.
ALTER TABLE user_roles ADD COLUMN granted_by TEXT REFERENCES users (id);

-- Team directory: keyset paging by lower-cased display name, then id.
CREATE INDEX users_directory ON users (lower(display_name), id);

-- The final-owner guard counts active owners; this keeps that count an index lookup.
CREATE INDEX user_roles_role ON user_roles (role_id, user_id);

-- Audit viewer filters, each newest first.
CREATE INDEX audit_actor ON audit_events (actor_id, occurred_at DESC, id);
CREATE INDEX audit_module ON audit_events (module, occurred_at DESC, id);
CREATE INDEX audit_type ON audit_events (entity_type, occurred_at DESC, id);
