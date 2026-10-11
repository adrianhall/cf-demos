/**
 * @file The production notes repository directly over SQLite, for storage states the service never
 *   produces but a repair script, a partial restore, or a future migration could: a link whose
 *   target row no longer exists at all (rendered as an "Unavailable record" tombstone, not
 *   dropped), a note row with no link rows (projected with an empty list rather than crashing), and
 *   a suspended or unknown user.
 */

import { describe, expect, it } from 'vitest';
import { D1NotesRepository } from '../../../src/data-worker/infrastructure/repositories/notes-repository.ts';
import { SqliteD1Port } from '../../fakes/sqlite-d1-port.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const NOTE = '00000000-0000-4000-8000-0000000000a1';
const AT = '2026-10-11T09:00:00.000Z';

/**
 * A repository over a database with one user and one note.
 *
 * @returns The repository and port.
 */
function world() {
  const port = new SqliteD1Port();
  port.db
    .prepare(
      "INSERT INTO users (id, email, display_name, status, created_at, updated_at) VALUES (?, 'u@example.com', 'U', 'active', ?, ?)"
    )
    .run(USER, AT, AT);
  port.db
    .prepare(
      `INSERT INTO notes (id, title, markdown, author_id, last_edited_by, version, created_at, updated_at)
       VALUES (?, 'Orphan', 'Body', ?, ?, 1, ?, ?)`
    )
    .run(NOTE, USER, USER, AT, AT);
  return { repository: new D1NotesRepository(port), port };
}

describe('D1NotesRepository storage edge cases', () => {
  it('projects a note with no link rows as an empty list', async () => {
    const { repository } = world();
    expect((await repository.getNote(NOTE))?.links).toEqual([]);
    const listed = await repository.listNotes({ after: null, limit: 10 }, null);
    expect(listed.map((note) => [note.id, note.links])).toEqual([[NOTE, []]]);
    const hits = await repository.searchNotes('"orphan"*', 10);
    expect(hits.map((hit) => hit.note.links)).toEqual([[]]);
  });

  it('keeps a link to a hard-deleted target as an unavailable tombstone', async () => {
    const { repository, port } = world();
    port.db.exec('PRAGMA foreign_keys = OFF');
    port.db
      .prepare(
        "INSERT INTO note_links (note_id, target_type, target_id, created_by, created_at) VALUES (?, 'deal', ?, ?, ?)"
      )
      .run(NOTE, '00000000-0000-4000-8000-00000000dead', USER, AT);
    expect((await repository.getNote(NOTE))?.links).toEqual([
      {
        type: 'deal',
        id: '00000000-0000-4000-8000-00000000dead',
        label: 'Unavailable record',
        available: false
      }
    ]);
  });

  it('resolves only active users', async () => {
    const { repository, port } = world();
    expect(await repository.activeUser(USER)).toEqual({ id: USER, displayName: 'U' });
    port.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(USER);
    expect(await repository.activeUser(USER)).toBeNull();
    expect(await repository.activeUser('00000000-0000-4000-8000-00000000ffff')).toBeNull();
  });
});
