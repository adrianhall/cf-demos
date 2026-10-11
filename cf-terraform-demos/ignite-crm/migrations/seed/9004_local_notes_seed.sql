-- Ignite CRM — LOCAL DEVELOPMENT SEED ONLY: two multi-linked Markdown notes.
--
-- Applied after 9003 by `pnpm seed:local`; never applied remotely. The first note is linked to
-- both Northwind contacts, Northwind Traders, the onboarding deal, and its project, so a reviewer
-- can open the same note from five records and find it by searching "workshop". The FTS index is
-- filled by the triggers in migrations/data/0004_notes.sql. Every insert is `OR IGNORE` on a fixed
-- id, so re-running the seed changes nothing.

INSERT OR IGNORE INTO notes
  (id, title, markdown, author_id, last_edited_by, version, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-000000000201', 'Onboarding workshop planning',
   '# Workshop plan

Met **Priya** and **Tom** to plan the two half-day onboarding sessions.

- Session one: pipeline basics
- Session two: delivery handover
- [x] Agree dates
- [ ] Send the attendee list

See the [Northwind site](https://northwind.example) for venue details.',
   '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003', 1,
   '2026-10-06T10:00:00.000Z', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000202', 'Contoso data platform discovery',
   'Elena wants a *phased* rollout. Budget sign-off expected next quarter.

```
Pilot: 3 teams, 6 weeks
```',
   '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 1,
   '2026-10-07T15:30:00.000Z', '2026-10-07T15:30:00.000Z');

INSERT OR IGNORE INTO note_links (note_id, target_type, target_id, created_by, created_at) VALUES
  ('00000000-0000-4000-8000-000000000201', 'contact', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000201', 'contact', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000201', 'company', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000201', 'deal', '00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000201', 'project', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000003', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000202', 'contact', '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-000000000002', '2026-10-07T15:30:00.000Z'),
  ('00000000-0000-4000-8000-000000000202', 'company', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', '2026-10-07T15:30:00.000Z');

INSERT OR IGNORE INTO audit_events (id, module, entity_type, entity_id, action, actor_id, request_id, metadata_json, occurred_at) VALUES
  ('00000000-0000-4000-8000-000000000211', 'notes', 'note', '00000000-0000-4000-8000-000000000201', 'created', '00000000-0000-4000-8000-000000000003', 'seed', '{"linkCount":5}', '2026-10-06T10:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000212', 'notes', 'note', '00000000-0000-4000-8000-000000000202', 'created', '00000000-0000-4000-8000-000000000002', 'seed', '{"linkCount":2}', '2026-10-07T15:30:00.000Z');
