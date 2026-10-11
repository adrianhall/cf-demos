-- Ignite CRM — LOCAL DEVELOPMENT SEED ONLY: sample deals, calls/meetings, and next actions.
--
-- Applied after 9001 by `pnpm seed:local`; never applied remotely (see 9001 for why the seed is a
-- migration stream). Dates are fixed, so after a few days some actions show as overdue — which is
-- exactly what the action stream should demonstrate. Every insert is `OR IGNORE` on a fixed id.

INSERT OR IGNORE INTO deals
  (id, title, company_id, primary_contact_id, owner_id, pipeline_id, stage_id, status, status_line,
   next_action_text, next_action_date, amount_minor, currency, expected_close_date, closed_at,
   version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000000d1', 'Northwind warehouse analytics',
   '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2',
   '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000013', 'pending', 'Waiting for contract sign',
   'Chase signed order form', '2026-10-09', 4500000, 'GBP', '2026-11-30', NULL,
   1, '2026-10-02T10:00:00.000Z', '2026-10-02T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000d2', 'Northwind support renewal',
   '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000012', 'pending', 'Budget approved; scoping seats',
   'Send renewal quote', '2026-10-20', 1200000, 'GBP', '2026-12-15', NULL,
   1, '2026-10-03T10:00:00.000Z', '2026-10-03T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000d3', 'Contoso data platform pilot',
   '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b3',
   '00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000011', 'pending', NULL,
   NULL, NULL, 800000, 'GBP', NULL, NULL,
   1, '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000d4', 'Northwind onboarding workshop',
   '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000014', 'won', 'Signed 5 Oct',
   NULL, NULL, 350000, 'GBP', NULL, '2026-10-05T15:00:00.000Z',
   2, '2026-09-20T10:00:00.000Z', '2026-10-05T15:00:00.000Z');

INSERT OR IGNORE INTO activities
  (id, type, subject, summary, occurred_at, duration_minutes, author_id, company_id, deal_id,
   version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'meeting', 'Warehouse analytics discovery',
   'Walked through current reporting. Priya owns budget; Tom owns the data feeds.',
   '2026-10-02T09:30:00.000Z', 60, '00000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d1',
   1, '2026-10-02T11:00:00.000Z', '2026-10-02T11:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000e2', 'call', 'Pilot scoping call', NULL,
   '2026-10-04T14:00:00.000Z', 20, '00000000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000d3',
   1, '2026-10-04T14:30:00.000Z', '2026-10-04T14:30:00.000Z');

INSERT OR IGNORE INTO activity_contacts (activity_id, contact_id) VALUES
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1'),
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b2'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000b3');

INSERT OR IGNORE INTO follow_ups
  (id, contact_id, assignee_id, text, due_date, status, completed_at, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-000000000003', 'Introduce the support team', NULL, 'open', NULL,
   1, '2026-10-03T12:00:00.000Z', '2026-10-03T12:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000b3',
   '00000000-0000-4000-8000-000000000002', 'Share pilot success criteria', '2026-10-10', 'open', NULL,
   1, '2026-10-04T15:00:00.000Z', '2026-10-04T15:00:00.000Z');

INSERT OR IGNORE INTO audit_events (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at) VALUES
  ('00000000-0000-4000-8000-0000000000c6', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d1', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-02T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c7', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d2', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-03T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c8', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d3', 'created', '00000000-0000-4000-8000-000000000002', 'seed', '{}', '2026-10-04T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000c9', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d4', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-09-20T10:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000ca', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d4', 'won', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-05T15:00:00.000Z');
