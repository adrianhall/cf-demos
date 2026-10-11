-- Ignite CRM — LOCAL DEVELOPMENT SEED ONLY: one converted project with tasks, plus a won deal that
-- is still waiting to be converted.
--
-- Applied after 9002 by `pnpm seed:local`; never applied remotely. The seeded won deal
-- 'Northwind onboarding workshop' (…d4) is converted here, so the reviewer can see a finished
-- conversion; a second won deal (…d5) is left unconverted so the reviewer can perform one.
-- Every insert is `OR IGNORE` on a fixed id, and the back-link update is conditional, so re-running
-- the seed changes nothing.

INSERT OR IGNORE INTO projects
  (id, name, description, status, source_deal_id, company_id, primary_contact_id, lead_id,
   target_date, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'Northwind onboarding workshop',
   'Two half-day sessions for the operations team.', 'active',
   '00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000004',
   '2026-11-20', 1, '2026-10-05T16:00:00.000Z', '2026-10-05T16:00:00.000Z');

INSERT OR IGNORE INTO conversion_attempts (source_deal_id, project_id, actor_id, state, created_at)
VALUES ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000101',
        '00000000-0000-4000-8000-000000000003', 'completed', '2026-10-05T16:00:00.000Z');

UPDATE deals SET project_id = '00000000-0000-4000-8000-000000000101', version = 3
 WHERE id = '00000000-0000-4000-8000-0000000000d4' AND project_id IS NULL;

INSERT OR IGNORE INTO tasks
  (id, project_id, title, description, status, priority, assignee_id, due_date, position,
   created_by, completed_at, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101',
   'Confirm attendee list', NULL, 'done', 'medium', '00000000-0000-4000-8000-000000000004',
   NULL, 0, '00000000-0000-4000-8000-000000000004', '2026-10-07T10:00:00.000Z',
   2, '2026-10-05T16:10:00.000Z', '2026-10-07T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000101',
   'Prepare workshop materials', 'Slides plus a printed checklist.', 'in_progress', 'high',
   '00000000-0000-4000-8000-000000000004', '2026-10-10', 0,
   '00000000-0000-4000-8000-000000000004', NULL, 1, '2026-10-05T16:20:00.000Z',
   '2026-10-05T16:20:00.000Z'),
  ('00000000-0000-4000-8000-000000000113', '00000000-0000-4000-8000-000000000101',
   'Book the training room', NULL, 'todo', 'urgent', '00000000-0000-4000-8000-000000000004',
   '2026-10-14', 0, '00000000-0000-4000-8000-000000000002', NULL, 1,
   '2026-10-05T16:30:00.000Z', '2026-10-05T16:30:00.000Z'),
  ('00000000-0000-4000-8000-000000000114', '00000000-0000-4000-8000-000000000101',
   'Send follow-up survey', NULL, 'todo', 'low', NULL, NULL, 1024,
   '00000000-0000-4000-8000-000000000002', NULL, 1, '2026-10-05T16:40:00.000Z',
   '2026-10-05T16:40:00.000Z');

-- A won deal awaiting conversion, for the reviewer's "Convert to project" step.
INSERT OR IGNORE INTO deals
  (id, title, company_id, primary_contact_id, owner_id, pipeline_id, stage_id, status, status_line,
   next_action_text, next_action_date, amount_minor, currency, expected_close_date, closed_at,
   version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000000d5', 'Contoso analytics rollout',
   '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b3',
   '00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000014', 'won', 'Signed 9 Oct',
   NULL, NULL, 2200000, 'GBP', NULL, '2026-10-09T14:00:00.000Z',
   2, '2026-09-25T10:00:00.000Z', '2026-10-09T14:00:00.000Z');

INSERT OR IGNORE INTO audit_events (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at) VALUES
  ('00000000-0000-4000-8000-0000000000cb', 'projects', 'project', '00000000-0000-4000-8000-000000000101', 'created-from-deal', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-05T16:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000cc', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d4', 'converted', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-05T16:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000000cd', 'crm', 'deal', '00000000-0000-4000-8000-0000000000d5', 'won', '00000000-0000-4000-8000-000000000003', 'seed', '{}', '2026-10-09T14:00:00.000Z');
