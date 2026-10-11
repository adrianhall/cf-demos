/**
 * @file The local-only seed applies cleanly on top of the committed schema, so `pnpm start` cannot
 *   fail on a constraint the schema enforces (for example, a next action on a won deal).
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { migratedDatabase } from '../../fakes/sqlite-d1-port.ts';

it('applies every local seed file to the migrated schema, twice', () => {
  const db = migratedDatabase();
  const dir = path.resolve(process.cwd(), 'migrations/seed');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (let run = 0; run < 2; run++) {
    for (const name of files) {
      db.exec(readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect(count('users')).toBe(5);
  expect(count('deals')).toBe(5);
  expect(count('projects')).toBe(1);
  expect(count('tasks')).toBe(4);
  expect(
    (
      db.prepare('SELECT count(*) AS n FROM deals WHERE project_id IS NOT NULL').get() as {
        n: number;
      }
    ).n
  ).toBe(1);
  expect(count('activity_contacts')).toBe(3);
  expect(count('follow_ups')).toBe(2);
  expect(count('notes')).toBe(2);
  expect(count('note_links')).toBe(7);
  // The FTS triggers indexed the seeded notes exactly once despite the second run.
  expect(count('notes_fts_docsize')).toBe(2);
  expect(
    (
      db
        .prepare('SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH \'"workshop"*\'')
        .get() as { n: number }
    ).n
  ).toBe(1);
});
