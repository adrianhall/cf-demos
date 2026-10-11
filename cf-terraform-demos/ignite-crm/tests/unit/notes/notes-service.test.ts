/**
 * @file Notes use cases through the public data-service interface, over the production repositories
 *   on in-memory SQLite (which applies the real FTS5 migration). Covers the atomic multi-link
 *   create — including a rollback proof that fails the write set at every statement — link
 *   validation (none, duplicate, unsupported, absent, deleted, concurrently deleted), the
 *   author-or-manager edit rule, link replacement with tombstones, versioning, idempotency, context
 *   feeds, bounded FTS search with safe query handling, and dependency failure.
 */

import { describe, expect, it } from 'vitest';
import type { ActorContext, DataService } from '../../../src/shared/data-service/contract.ts';
import type { Role } from '../../../src/shared/permissions.ts';
import {
  createFakeDataService,
  type FakeStore,
  testRuntime
} from '../../fakes/fake-data-service.ts';

let keyCounter = 0;

/**
 * A fresh idempotency key.
 *
 * @returns Mutation metadata.
 */
function key(): { idempotencyKey: string } {
  return { idempotencyKey: `notes-key-${++keyCounter}` };
}

/**
 * Capture a rejection.
 *
 * @param promise The operation.
 * @returns The error.
 */
async function failure(promise: Promise<unknown>): Promise<{
  code: string;
  message: string;
  fields?: Record<string, string>;
  retryable?: boolean;
}> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected failure');
}

/**
 * A fake with one user per role, two contacts at one company, a won deal, and its project.
 *
 * @returns Everything a test needs.
 */
async function world() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const actors = new Map<Role, ActorContext>();
  for (const role of ['owner', 'manager', 'sales', 'delivery', 'read-only'] as const) {
    const email = `${role}@example.com`;
    actors.set(role, {
      email,
      userId: store.addUser(email, role),
      requestId: `req-${role}`,
      channel: 'api'
    });
  }
  const actor = (role: Role): ActorContext => actors.get(role)!;
  const contactInput = (firstName: string, companyId: string | null) => ({
    firstName,
    lastName: null,
    email: null,
    phone: null,
    jobTitle: null,
    companyId,
    companyName: companyId === null ? 'Northwind' : null
  });
  const priya = await service.crm.createContact(actor('sales'), contactInput('Priya', null), key());
  const companyId = priya.company!.id;
  const tom = await service.crm.createContact(
    actor('sales'),
    contactInput('Tom', companyId),
    key()
  );
  const deal = await service.crm.createDeal(
    actor('sales'),
    {
      title: 'Support renewal',
      primaryContactId: priya.id,
      amountMinor: 100,
      statusLine: null,
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    key()
  );
  const project = await service.projects.convertDeal(
    actor('sales'),
    deal.id,
    { markWon: true },
    deal.version,
    key()
  );
  const links = [
    { type: 'contact' as const, id: priya.id },
    { type: 'contact' as const, id: tom.id },
    { type: 'company' as const, id: companyId },
    { type: 'deal' as const, id: deal.id },
    { type: 'project' as const, id: project.id }
  ];
  return { service, store, actor, priya, tom, companyId, deal, project, links };
}

/**
 * Create a meeting note linked to every seeded record.
 *
 * @param service The service.
 * @param actor The author.
 * @param links Links.
 * @param overrides Title or body.
 * @returns The note.
 */
function meetingNote(
  service: DataService,
  actor: ActorContext,
  links: readonly { type: 'contact' | 'company' | 'deal' | 'project'; id: string }[],
  overrides: { title?: string; markdown?: string } = {}
) {
  return service.notes.createNote(
    actor,
    {
      title: overrides.title ?? 'Kick-off meeting',
      markdown:
        overrides.markdown ?? '# Agenda\n\n- Discussed **pricing** tiers\n- [ ] Send the quote',
      links: [...links]
    },
    key()
  );
}

/**
 * Row counts every note write touches.
 *
 * @param store The store.
 * @returns Counts.
 */
function noteRows(store: FakeStore) {
  return {
    notes: store.count('notes'),
    links: store.count('note_links'),
    // External-content FTS5 reads `count(*)` through to `notes`; the docsize shadow table holds one
    // row per document actually in the index.
    fts: store.count('notes_fts_docsize'),
    audit: store.count('audit_events', "entity_type = 'note'"),
    idempotency: store.count('idempotency_records', "operation LIKE 'notes.%'")
  };
}

describe('createNote', () => {
  it('creates one note linked to two contacts, their company, the deal, and its project', async () => {
    const { service, store, actor, links, priya, tom, companyId, deal, project } = await world();
    const note = await meetingNote(service, actor('sales'), links);

    expect(note).toMatchObject({
      title: 'Kick-off meeting',
      author: { id: actor('sales').userId },
      lastEditedBy: { id: actor('sales').userId },
      version: 1
    });
    expect(note.links.map((link) => [link.type, link.label, link.available])).toEqual([
      ['contact', 'Priya', true],
      ['contact', 'Tom', true],
      ['company', 'Northwind', true],
      ['deal', 'Support renewal', true],
      ['project', 'Support renewal', true]
    ]);
    expect(noteRows(store)).toEqual({ notes: 1, links: 5, fts: 1, audit: 1, idempotency: 1 });

    // The same note id from every linked context.
    for (const [type, id] of [
      ['contact', priya.id],
      ['contact', tom.id],
      ['company', companyId],
      ['deal', deal.id],
      ['project', project.id]
    ] as const) {
      const page = await service.notes.listNotes(actor('read-only'), {
        linkType: type,
        linkId: id,
        limit: 25
      });
      expect(page.items.map((item) => item.id)).toEqual([note.id]);
    }
    const detail = await service.notes.getNote(actor('read-only'), note.id);
    expect(detail.note.markdown).toContain('Discussed **pricing**');
    expect(detail.history.map((entry) => entry.action)).toEqual(['created']);
  });

  it('normalises newlines, sorts links canonically, and audits a digest instead of the body', async () => {
    const { service, store, actor, links } = await world();
    const note = await service.notes.createNote(
      actor('sales'),
      {
        title: '  Call  ',
        markdown: 'Line one\r\nLine two\rLine three',
        links: [...links].reverse()
      },
      key()
    );
    expect(note.title).toBe('Call');
    expect(note.markdown).toBe('Line one\nLine two\nLine three');
    expect(note.links.map((link) => link.type)).toEqual([
      'contact',
      'contact',
      'company',
      'deal',
      'project'
    ]);
    const audit = store.port.db
      .prepare("SELECT metadata_json FROM audit_events WHERE entity_type = 'note'")
      .get() as { metadata_json: string };
    const metadata = JSON.parse(audit.metadata_json) as Record<string, unknown>;
    expect(metadata.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(metadata.linkCount).toBe(5);
    expect(audit.metadata_json).not.toContain('Line one');
  });

  it('rejects no links, duplicate links, unsupported types, and an oversized body', async () => {
    const { service, store, actor, priya } = await world();
    const create = (input: unknown) =>
      failure(service.notes.createNote(actor('sales'), input as never, key()));

    expect(await create({ title: 'T', markdown: 'Body', links: [] })).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { links: 'Link the note to at least one record.' }
    });
    expect(
      await create({
        title: 'T',
        markdown: 'Body',
        links: [
          { type: 'contact', id: priya.id },
          { type: 'contact', id: priya.id }
        ]
      })
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { 'links.1': 'This record is already linked.' }
    });
    expect(
      (await create({ title: 'T', markdown: 'Body', links: [{ type: 'note', id: priya.id }] }))
        .fields
    ).toHaveProperty('links.0.type');
    expect(
      await create({
        title: 'T',
        markdown: 'é'.repeat(32 * 1024 + 1),
        links: [{ type: 'contact', id: priya.id }]
      })
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { markdown: 'Body must be at most 64 KiB.' }
    });
    expect(
      (await create({ title: 'T', markdown: '  \n ', links: [{ type: 'contact', id: priya.id }] }))
        .fields
    ).toEqual({ markdown: 'Body is required.' });
    expect(
      (
        await create({
          title: 'T',
          markdown: 'Body',
          links: [{ type: 'contact', id: priya.id }],
          author: 'someone'
        })
      ).code
    ).toBe('VALIDATION_FAILED');
    expect(store.count('notes')).toBe(0);
  });

  it('refuses embedded snippet markers rather than silently changing a valid body', async () => {
    const { service, store, actor, priya } = await world();
    const links = [{ type: 'contact' as const, id: priya.id }];
    expect(
      (await failure(meetingNote(service, actor('sales'), links, { markdown: '\uE000' }))).fields
    ).toHaveProperty('markdown');
    expect(
      (await failure(meetingNote(service, actor('sales'), links, { title: '\uE001' }))).fields
    ).toHaveProperty('title');
    expect(store.count('notes')).toBe(0);
  });

  it('names every absent or deleted target and writes nothing', async () => {
    const { service, store, actor, priya, deal } = await world();
    store.exec('UPDATE deals SET deleted_at = ? WHERE id = ?', '2026-10-11T08:00:00.000Z', deal.id);
    const missing = '00000000-0000-4000-8000-00000000ffff';
    const error = await failure(
      meetingNote(service, actor('sales'), [
        { type: 'contact', id: priya.id },
        { type: 'deal', id: deal.id },
        { type: 'project', id: missing }
      ])
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: {
        'links.1': 'This record does not exist or is no longer available.',
        'links.2': 'This record does not exist or is no longer available.'
      }
    });
    // A contact id offered as a company is simply not a live company.
    expect(
      (await failure(meetingNote(service, actor('sales'), [{ type: 'company', id: priya.id }])))
        .fields
    ).toEqual({ 'links.0': 'This record does not exist or is no longer available.' });
    expect(noteRows(store).notes).toBe(0);
  });

  it('rolls back the whole note when a target is deleted between validation and commit', async () => {
    const { service, store, actor, links, tom } = await world();
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run('x', tom.id);
    });
    expect((await failure(meetingNote(service, actor('sales'), links))).code).toBe('NOT_FOUND');
    expect(noteRows(store)).toEqual({ notes: 0, links: 0, fts: 0, audit: 0, idempotency: 0 });
  });

  it('rolls back every row when the write set fails at any statement', async () => {
    const { service, store, actor, links } = await world();
    await meetingNote(service, actor('sales'), links);
    const size = store.lastWriteSetSize;
    const before = noteRows(store);
    for (let index = 0; index < size; index++) {
      store.failNextWriteAt(index);
      const error = await failure(meetingNote(service, actor('sales'), links));
      expect(error).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
      expect(noteRows(store)).toEqual(before);
    }
    // Searching never finds a rolled-back note.
    expect((await service.notes.searchNotes(actor('sales'), 'kick-off')).items).toHaveLength(1);
  });

  it('requires note.write and read access to every linked record type', async () => {
    const { service, store, actor, links, priya, project } = await world();
    expect((await failure(meetingNote(service, actor('read-only'), links))).code).toBe('FORBIDDEN');
    // A delivery user may link projects and customers (both readable to the role) …
    await meetingNote(service, actor('delivery'), [
      { type: 'contact', id: priya.id },
      { type: 'project', id: project.id }
    ]);
    // … but without project.read a project link is refused, whatever else is linked.
    store.exec(
      "DELETE FROM role_permissions WHERE role_id = 'sales' AND permission = 'project.read'"
    );
    expect(
      (
        await failure(
          meetingNote(service, actor('sales'), [
            { type: 'contact', id: priya.id },
            { type: 'project', id: project.id }
          ])
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(store.count('notes')).toBe(1);
  });

  it('replays a retried create and refuses a reused key with a different note', async () => {
    const { service, store, actor, links } = await world();
    const meta = key();
    const input = { title: 'Retry', markdown: 'Body', links: [...links] };
    const first = await service.notes.createNote(actor('sales'), input, meta);
    // Same request, links in a different order: still the same intent.
    const again = await service.notes.createNote(
      actor('sales'),
      { ...input, links: [...links].reverse() },
      meta
    );
    expect(again.id).toBe(first.id);
    expect(store.count('notes')).toBe(1);
    expect(
      (await failure(service.notes.createNote(actor('sales'), { ...input, title: 'Other' }, meta)))
        .code
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('fails closed with a retryable error when storage is unavailable', async () => {
    const { service, store, actor, links } = await world();
    store.failing = true;
    expect(await failure(meetingNote(service, actor('sales'), links))).toMatchObject({
      code: 'DEPENDENCY_FAILURE',
      retryable: true
    });
    expect(await failure(service.notes.searchNotes(actor('sales'), 'agenda'))).toMatchObject({
      code: 'DEPENDENCY_FAILURE'
    });
  });
});

describe('updateNote', () => {
  it('edits text and replaces links in one versioned write, keeping one shared version', async () => {
    const { service, store, actor, links, priya, deal } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    const updated = await service.notes.updateNote(
      actor('sales'),
      note.id,
      {
        markdown: 'Revised **pricing**',
        links: [
          { type: 'contact', id: priya.id },
          { type: 'deal', id: deal.id }
        ]
      },
      1,
      key()
    );
    expect(updated).toMatchObject({ version: 2, markdown: 'Revised **pricing**' });
    expect(updated.links.map((link) => link.type)).toEqual(['contact', 'deal']);
    expect(store.count('note_links')).toBe(2);
    const audit = store.port.db
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE entity_type = 'note' AND action = 'updated'"
      )
      .get() as { metadata_json: string };
    expect(JSON.parse(audit.metadata_json)).toMatchObject({
      fields: 'links,markdown',
      titleChanged: false,
      linkCount: 2,
      version: 2
    });
    expect(audit.metadata_json).not.toContain('Revised');
    expect((await service.notes.getNote(actor('sales'), note.id)).note).toEqual(updated);
    // The search index follows the edit.
    expect((await service.notes.searchNotes(actor('sales'), 'agenda')).items).toHaveLength(0);
    expect((await service.notes.searchNotes(actor('sales'), 'revised')).items).toHaveLength(1);
  });

  it('adds and removes links in the same edit', async () => {
    const { service, store, actor, links, priya, project } = await world();
    const note = await meetingNote(service, actor('sales'), [{ type: 'contact', id: priya.id }]);
    const swapped = await service.notes.updateNote(
      actor('sales'),
      note.id,
      { links: [{ type: 'project', id: project.id }] },
      1,
      key()
    );
    expect(swapped.links.map((link) => link.id)).toEqual([project.id]);
    expect(store.count('note_links')).toBe(1);
    // Every seeded record added at once (the add path for several types together).
    const all = await service.notes.updateNote(actor('sales'), note.id, { links }, 2, key());
    expect(all.links).toHaveLength(5);
    expect(all.lastEditedBy.id).toBe(actor('sales').userId);
  });

  it('keeps a link to a since-deleted record as an unavailable tombstone', async () => {
    const { service, store, actor, links, tom } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    store.exec(
      'UPDATE contacts SET deleted_at = ? WHERE id = ?',
      '2026-10-11T10:00:00.000Z',
      tom.id
    );
    const read = await service.notes.getNote(actor('sales'), note.id);
    expect(read.note.links.find((link) => link.id === tom.id)).toMatchObject({
      label: 'Tom',
      available: false
    });
    // Editing only the title keeps every link, tombstone included.
    const updated = await service.notes.updateNote(
      actor('sales'),
      note.id,
      { title: 'Renamed' },
      1,
      key()
    );
    expect(updated.links).toHaveLength(5);
    // Re-adding a deleted record after removing it is refused.
    const without = links.filter((link) => link.id !== tom.id);
    await service.notes.updateNote(actor('sales'), note.id, { links: without }, 2, key());
    expect(
      (
        await failure(
          service.notes.updateNote(
            actor('sales'),
            note.id,
            { links: [...without, links[1]!] },
            3,
            key()
          )
        )
      ).fields
    ).toEqual({ 'links.4': 'This record does not exist or is no longer available.' });
  });

  it('lets authors edit their own notes and managers anyone’s, but not other writers', async () => {
    const { service, actor, links } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    expect(
      (
        await failure(
          service.notes.updateNote(actor('delivery'), note.id, { title: 'X' }, 1, key())
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (
        await failure(
          service.notes.updateNote(actor('read-only'), note.id, { title: 'X' }, 1, key())
        )
      ).code
    ).toBe('FORBIDDEN');
    const managed = await service.notes.updateNote(
      actor('manager'),
      note.id,
      { title: 'Manager edit' },
      1,
      key()
    );
    expect(managed).toMatchObject({
      author: { id: actor('sales').userId },
      lastEditedBy: { id: actor('manager').userId },
      version: 2
    });
  });

  it('reports stale versions, absent notes, empty changes, and empty link sets', async () => {
    const { service, store, actor, links } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    await service.notes.updateNote(actor('sales'), note.id, { title: 'First' }, 1, key());
    expect(
      (
        await failure(
          service.notes.updateNote(actor('sales'), note.id, { title: 'Stale' }, 1, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect(
      (
        await failure(
          service.notes.updateNote(
            actor('sales'),
            '00000000-0000-4000-8000-00000000ffff',
            { title: 'X' },
            1,
            key()
          )
        )
      ).code
    ).toBe('NOT_FOUND');
    expect(
      (await failure(service.notes.updateNote(actor('sales'), note.id, {} as never, 2, key()))).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (await failure(service.notes.updateNote(actor('sales'), note.id, { links: [] }, 2, key())))
        .fields
    ).toEqual({ links: 'Link the note to at least one record.' });
    // A concurrent edit between read and commit loses cleanly.
    store.beforeNextCommit((db) => {
      db.prepare('UPDATE notes SET version = version + 1 WHERE id = ?').run(note.id);
    });
    expect(
      (
        await failure(
          service.notes.updateNote(actor('sales'), note.id, { title: 'Race' }, 2, key())
        )
      ).code
    ).toBe('VERSION_MISMATCH');
    expect((await service.notes.getNote(actor('sales'), note.id)).note.title).toBe('First');
  });

  it('replays a lost-response retry of an update', async () => {
    const { service, actor, links } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    const meta = key();
    const first = await service.notes.updateNote(
      actor('sales'),
      note.id,
      { title: 'Once' },
      1,
      meta
    );
    const again = await service.notes.updateNote(
      actor('sales'),
      note.id,
      { title: 'Once' },
      1,
      meta
    );
    expect(again).toEqual(first);
    expect((await service.notes.getNote(actor('sales'), note.id)).note.version).toBe(2);
  });
});

describe('listNotes and searchNotes', () => {
  it('pages notes newest first with an opaque cursor', async () => {
    const { service, actor, links } = await world();
    for (const title of ['One', 'Two', 'Three']) {
      await meetingNote(service, actor('sales'), links, { title });
    }
    const first = await service.notes.listNotes(actor('sales'), { limit: 2 });
    expect(first.items.map((note) => note.title)).toEqual(['Three', 'Two']);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.notes.listNotes(actor('sales'), {
      limit: 2,
      cursor: first.nextCursor!
    });
    expect(second).toMatchObject({ items: [{ title: 'One' }], nextCursor: null });
    expect(
      (await failure(service.notes.listNotes(actor('sales'), { limit: 2, cursor: 'bad!' }))).code
    ).toBe('VALIDATION_FAILED');
    expect(
      (await failure(service.notes.listNotes(actor('sales'), { limit: 2, linkType: 'contact' })))
        .code
    ).toBe('VALIDATION_FAILED');
  });

  it('finds title and body words by prefix, ranks title matches first, and snippets as text', async () => {
    const { service, actor, links } = await world();
    const body = await meetingNote(service, actor('sales'), links, {
      title: 'Weekly sync',
      markdown: 'We agreed the **pricing** model with the café team.'
    });
    const title = await meetingNote(service, actor('sales'), links, {
      title: 'Pricing review',
      markdown: 'Numbers attached.'
    });
    const result = await service.notes.searchNotes(actor('read-only'), 'PRIC');
    expect(result.truncated).toBe(false);
    expect(result.items.every((hit) => Number.isFinite(hit.rank))).toBe(true);
    expect(result.items[0]!.rank).toBeLessThan(result.items[1]!.rank);
    expect(result.items.map((hit) => hit.note.id)).toEqual([title.id, body.id]);
    const snippet = result.items[1]!.snippet;
    expect(snippet.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
      'pricing'
    ]);
    expect(snippet.map((segment) => segment.text).join('')).toContain('**pricing** model');
    // Diacritics are folded, and every token must match.
    expect((await service.notes.searchNotes(actor('sales'), 'cafe team')).items).toHaveLength(1);
    expect((await service.notes.searchNotes(actor('sales'), 'cafe numbers')).items).toHaveLength(0);
  });

  it('treats FTS syntax and punctuation as plain text, never as a query expression', async () => {
    const { service, actor, links } = await world();
    await meetingNote(service, actor('sales'), links, {
      title: 'Plain',
      markdown: 'Contains OR and NEAR as words.'
    });
    for (const text of [
      '"unbalanced',
      'title:plain',
      'a* OR b*',
      'NEAR(x y)',
      '-plain',
      "'; DROP"
    ]) {
      const result = await service.notes.searchNotes(actor('sales'), text);
      expect(result.truncated).toBe(false);
    }
    // `contains:plain` would be a column filter in raw FTS syntax; here it is two words.
    expect((await service.notes.searchNotes(actor('sales'), 'contains:plain')).items).toHaveLength(
      1
    );
    expect((await service.notes.searchNotes(actor('sales'), 'OR near')).items).toHaveLength(1);
    expect(await service.notes.searchNotes(actor('sales'), '!!')).toEqual({
      items: [],
      truncated: false
    });
  });

  it('bounds search text and results, and requires note.read', async () => {
    const { service, store, actor, links } = await world();
    expect((await failure(service.notes.searchNotes(actor('sales'), ' a '))).fields).toEqual({
      q: 'Search for at least 2 characters.'
    });
    expect((await failure(service.notes.searchNotes(actor('sales'), 'x'.repeat(201)))).code).toBe(
      'VALIDATION_FAILED'
    );
    for (let index = 0; index < 51; index++) {
      await meetingNote(service, actor('sales'), links, { title: `Bulk ${index}` });
    }
    const result = await service.notes.searchNotes(actor('sales'), 'bulk');
    expect(result.items).toHaveLength(50);
    expect(result.truncated).toBe(true);
    store.exec(
      "DELETE FROM role_permissions WHERE role_id = 'read-only' AND permission = 'note.read'"
    );
    expect((await failure(service.notes.searchNotes(actor('read-only'), 'bulk'))).code).toBe(
      'FORBIDDEN'
    );
    expect((await failure(service.notes.listNotes(actor('read-only'), { limit: 5 }))).code).toBe(
      'FORBIDDEN'
    );
    expect(
      (
        await failure(
          service.notes.getNote(actor('read-only'), '00000000-0000-4000-8000-00000000ffff')
        )
      ).code
    ).toBe('FORBIDDEN');
  });

  it('excludes deleted notes from reads, lists, and search', async () => {
    const { service, store, actor, links } = await world();
    const note = await meetingNote(service, actor('sales'), links);
    store.exec('UPDATE notes SET deleted_at = ? WHERE id = ?', '2026-10-11T11:00:00.000Z', note.id);
    expect(store.count('notes_fts_docsize')).toBe(0);
    expect((await failure(service.notes.getNote(actor('sales'), note.id))).code).toBe('NOT_FOUND');
    expect((await service.notes.listNotes(actor('sales'), { limit: 5 })).items).toHaveLength(0);
    expect((await service.notes.searchNotes(actor('sales'), 'agenda')).items).toHaveLength(0);
  });
});
