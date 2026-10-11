/**
 * @file Notes against real D1 in workerd: the production composition over the real `D1Adapter`.
 *   Proves what the SQLite unit fake cannot: that D1's FTS5 build indexes, re-indexes, and
 *   de-indexes notes through the migration's triggers (with Unicode folding and injection-like
 *   input), and that a failure at the end of the note write set rolls back the note, its links, the
 *   FTS entry, audit, and idempotency rows on D1 itself.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { composeWithPort } from '../../../src/data-worker/composition.ts';
import {
  D1Adapter,
  type D1Port,
  type D1TransactionPort,
  sql
} from '../../../src/data-worker/infrastructure/d1/d1-port.ts';
import type { ActorContext, DataService } from '../../../src/shared/data-service/contract.ts';
import { migrate, seedUser } from '../support.ts';

/**
 * A real D1 port whose next write set gets one extra statement that always fails.
 */
class FailingTailPort implements D1Port {
  /**
   * When set, the next write set fails at its final statement.
   */
  failNext = false;

  /**
   * @param inner The real adapter.
   */
  constructor(private readonly inner: D1Adapter) {}

  /**
   * @inheritdoc
   */
  read<T>(statement: Parameters<D1Port['read']>[0]): Promise<readonly T[]> {
    return this.inner.read<T>(statement);
  }

  /**
   * @inheritdoc
   */
  readOne<T>(statement: Parameters<D1Port['readOne']>[0]): Promise<T | null> {
    return this.inner.readOne<T>(statement);
  }

  /**
   * @inheritdoc
   */
  transaction<T>(work: (tx: D1TransactionPort) => Promise<T>): Promise<T> {
    return this.inner.transaction(async (tx) => {
      const result = await work(tx);
      if (this.failNext) {
        this.failNext = false;
        tx.write(sql('INSERT INTO table_that_does_not_exist (x) VALUES (1)'));
      }
      return result;
    });
  }
}

/**
 * Count rows with a constant predicate.
 *
 * @param table Table name.
 * @param where Predicate.
 * @returns The count.
 */
async function count(table: string, where = '1 = 1'): Promise<number> {
  const row = await env.DATA_DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

let sales: ActorContext;
let port: FailingTailPort;
let service: DataService;
let links: { type: 'contact' | 'company'; id: string }[];

beforeAll(async () => {
  await migrate();
  const userId = await seedUser('notes-sales@example.com', 'sales');
  sales = { email: 'notes-sales@example.com', userId, requestId: 'notes-it', channel: 'api' };
  port = new FailingTailPort(new D1Adapter(env.DATA_DB));
  service = composeWithPort(port, 'owner@example.com', {
    now: () => new Date(),
    newId: () => crypto.randomUUID()
  });
  const contact = await service.crm.createContact(
    sales,
    {
      firstName: 'Zoë',
      lastName: 'Notes',
      email: null,
      phone: null,
      jobTitle: null,
      companyId: null,
      companyName: 'FTS Ltd'
    },
    { idempotencyKey: 'it-notes-contact' }
  );
  links = [
    { type: 'contact', id: contact.id },
    { type: 'company', id: contact.company?.id ?? '' }
  ];
});

describe('notes on real D1', () => {
  it('indexes, re-indexes, and de-indexes through the FTS5 triggers', async () => {
    const note = await service.notes.createNote(
      sales,
      { title: 'Résumé of the café visit', markdown: 'Agreed the naïve rollout plan.', links },
      { idempotencyKey: 'it-notes-create' }
    );
    // Diacritics fold in both directions, and prefixes match.
    expect((await service.notes.searchNotes(sales, 'resume cafe')).items[0]?.note.id).toBe(note.id);
    expect((await service.notes.searchNotes(sales, 'naiv')).items).toHaveLength(1);
    // Injection-like and operator-laden text is just words.
    for (const text of ['"', 'title:x', "'); DROP TABLE notes; --", 'a NEAR b', '*']) {
      await expect(service.notes.searchNotes(sales, `${text} xx`)).resolves.toBeDefined();
    }

    await service.notes.updateNote(
      sales,
      note.id,
      { markdown: 'Switched to the phased rollout.' },
      1,
      { idempotencyKey: 'it-notes-update' }
    );
    expect((await service.notes.searchNotes(sales, 'naive')).items).toHaveLength(0);
    expect((await service.notes.searchNotes(sales, 'phased')).items).toHaveLength(1);

    await env.DATA_DB.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), note.id)
      .run();
    expect((await service.notes.searchNotes(sales, 'phased')).items).toHaveLength(0);
    // FTS integrity: the external-content index agrees with the live notes.
    await env.DATA_DB.prepare("INSERT INTO notes_fts (notes_fts) VALUES ('integrity-check')").run();
  });

  it('rolls back the note, links, index entry, audit, and idempotency when the write fails', async () => {
    const before = {
      notes: await count('notes'),
      links: await count('note_links'),
      indexed: await count('notes_fts_docsize'),
      audit: await count('audit_events', "entity_type = 'note'")
    };
    port.failNext = true;
    const failure = await service.notes
      .createNote(
        sales,
        { title: 'Doomed quokka note', markdown: 'Never stored.', links },
        { idempotencyKey: 'it-notes-fail' }
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect({
      notes: await count('notes'),
      links: await count('note_links'),
      indexed: await count('notes_fts_docsize'),
      audit: await count('audit_events', "entity_type = 'note'")
    }).toEqual(before);
    expect(await count('idempotency_records', "idempotency_key = 'it-notes-fail'")).toBe(0);
    expect((await service.notes.searchNotes(sales, 'quokka')).items).toHaveLength(0);

    const retried = await service.notes.createNote(
      sales,
      { title: 'Doomed quokka note', markdown: 'Stored now.', links },
      { idempotencyKey: 'it-notes-fail' }
    );
    expect((await service.notes.searchNotes(sales, 'quokka')).items[0]?.note.id).toBe(retried.id);
  });
});
