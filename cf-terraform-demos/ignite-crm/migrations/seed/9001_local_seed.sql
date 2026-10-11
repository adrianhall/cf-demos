-- Ignite CRM — LOCAL DEVELOPMENT SEED ONLY.
--
-- Applied by `pnpm seed:local` (part of `pnpm start`) to the local D1 simulation only, through the
-- repository migration helper with `--local --dir migrations/seed`. `cf d1 query` has no local
-- mode, so the seed is shaped as a migration in its own directory. It is never applied remotely:
-- `migrate:remote` reads only migrations/data.
--
-- Every insert is `OR IGNORE` on a fixed id, so re-running is harmless even if the migration
-- bookkeeping is reset.
-- Identities match the dev login page in vite.config.ts. owner@example.com is also the local
-- admin_email, so it would become the bootstrap owner even without this row.

INSERT OR IGNORE INTO users (id, email, display_name, status, version, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com', 'Olivia Owner', 'active', 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000002', 'manager@example.com', 'Morgan Manager', 'active', 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000003', 'sales@example.com', 'Sam Sales', 'active', 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000004', 'delivery@example.com', 'Dana Delivery', 'active', 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000005', 'readonly@example.com', 'Riley Reader', 'active', 1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z');

INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'owner', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000002', 'manager', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000003', 'sales', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000004', 'delivery', '2026-10-01T09:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000005', 'read-only', '2026-10-01T09:00:00.000Z');

INSERT OR IGNORE INTO companies (id, name, address, stock_symbol, companies_house_url, primary_contact_id, version, created_by, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'Northwind Traders', '12 Harbour Street
Bristol BS1 4XX', NULL, 'https://find-and-update.company-information.service.gov.uk/company/01234567', '00000000-0000-4000-8000-0000000000b1', 1, '00000000-0000-4000-8000-000000000003', '2026-10-01T09:05:00.000Z', '2026-10-01T09:05:00.000Z'),
  ('00000000-0000-4000-8000-0000000000a2', 'Contoso Analytics', '1 Canary Wharf
London E14 5AB', 'LSE:CTSO', NULL, NULL, 1, '00000000-0000-4000-8000-000000000003', '2026-10-01T09:10:00.000Z', '2026-10-01T09:10:00.000Z');

INSERT OR IGNORE INTO contacts (id, first_name, last_name, display_name, email, phone, job_title, company_id, owner_id, version, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'Priya', 'Shah', 'Priya Shah', 'priya.shah@northwind.example', '+44 117 496 0001', 'Operations Director', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000003', 1, '2026-10-01T09:06:00.000Z', '2026-10-01T09:06:00.000Z'),
  ('00000000-0000-4000-8000-0000000000b2', 'Tom', 'Okafor', 'Tom Okafor', 'tom.okafor@northwind.example', NULL, 'IT Manager', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000003', 1, '2026-10-01T09:07:00.000Z', '2026-10-01T09:07:00.000Z'),
  ('00000000-0000-4000-8000-0000000000b3', 'Elena', 'Rossi', 'Elena Rossi', 'elena@contoso.example', '+44 20 7946 0002', 'Head of Data', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', 1, '2026-10-01T09:11:00.000Z', '2026-10-01T09:11:00.000Z');

INSERT OR IGNORE INTO audit_events (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'crm', 'company', '00000000-0000-4000-8000-0000000000a1', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-01T09:05:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c2', 'crm', 'company', '00000000-0000-4000-8000-0000000000a2', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-01T09:10:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c3', 'crm', 'contact', '00000000-0000-4000-8000-0000000000b1', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-01T09:06:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c4', 'crm', 'contact', '00000000-0000-4000-8000-0000000000b2', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-01T09:07:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c5', 'crm', 'contact', '00000000-0000-4000-8000-0000000000b3', 'created', '00000000-0000-4000-8000-000000000002', 'seed', '{}', '2026-10-01T09:11:00.000Z');
