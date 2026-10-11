/**
 * @file D1 adapter for the notes use cases. All SQL is constant text with bound parameters; lists
 *   of ids are bound as one JSON array and expanded with `json_each`, so statement text never
 *   depends on input. A page of notes costs two queries however many links they carry: one for the
 *   notes and one for every link (with its current label) on that page. FTS5 stays inside this
 *   file. The application hands in a `MATCH` expression it built itself from tokens (`ftsQuery` in
 *   the notes domain); client text never reaches this module. The index is maintained by the
 *   triggers in `migrations/data/0004_notes.sql`, inside the same write set as the note, so a
 *   rolled-back note is never searchable.
 */

import type { UserRef } from '../../../shared/api/crm.ts';
import type {
  Note,
  NoteDetail,
  NoteLink,
  NoteLinkRef,
  NoteLinkType,
  NoteSummary
} from '../../../shared/api/notes.ts';
import {
  type NoteListCriteria,
  type NoteRow,
  type NotesRepository,
  sortLinksForDisplay,
  type StoredSearchHit
} from '../../application/notes/notes-service.ts';
import type { MutationEnvelope } from '../../application/shared/mutations.ts';
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '../../domain/notes/notes.ts';
import { type D1Port, type D1TransactionPort, sql, type SqlValue } from '../d1/d1-port.ts';
import { D1IdempotencyReader, writeEnvelope } from './envelope.ts';

/**
 * A guard query, per target type, counting the live record with a given id. Constant text for each
 * type: the table name is chosen from this map, never from input.
 */
const LIVE_TARGET_COUNT: Readonly<Record<NoteLinkType, string>> = {
  contact: 'SELECT count(*) FROM contacts WHERE id = ? AND deleted_at IS NULL',
  company: 'SELECT count(*) FROM companies WHERE id = ? AND deleted_at IS NULL',
  deal: 'SELECT count(*) FROM deals WHERE id = ? AND deleted_at IS NULL',
  project: 'SELECT count(*) FROM projects WHERE id = ? AND deleted_at IS NULL'
};

/**
 * Live records among a JSON array of ids, per type, with their labels.
 */
const LIVE_TARGETS = `
  SELECT 'contact' AS type, id, display_name AS label FROM contacts
   WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT 'company', id, name FROM companies
   WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT 'deal', id, title FROM deals
   WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))
  UNION ALL
  SELECT 'project', id, name FROM projects
   WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))`;

/**
 * Every link on a JSON array of note ids, with the target's current label and availability. A
 * target that is deleted (or, defensively, missing) keeps its link but is reported unavailable.
 */
const LINKS_FOR_NOTES = `
  SELECT l.note_id, l.target_type AS type, l.target_id AS id,
         coalesce(c.display_name, co.name, d.title, p.name) AS label,
         CASE l.target_type
           WHEN 'contact' THEN c.id IS NOT NULL AND c.deleted_at IS NULL
           WHEN 'company' THEN co.id IS NOT NULL AND co.deleted_at IS NULL
           WHEN 'deal' THEN d.id IS NOT NULL AND d.deleted_at IS NULL
           ELSE p.id IS NOT NULL AND p.deleted_at IS NULL
         END AS available
    FROM note_links l
    LEFT JOIN contacts c ON l.target_type = 'contact' AND c.id = l.target_id
    LEFT JOIN companies co ON l.target_type = 'company' AND co.id = l.target_id
    LEFT JOIN deals d ON l.target_type = 'deal' AND d.id = l.target_id
    LEFT JOIN projects p ON l.target_type = 'project' AND p.id = l.target_id
   WHERE l.note_id IN (SELECT value FROM json_each(?))`;

/**
 * Row shape of a note projection (without links).
 */
interface NoteProjectionRow {
  id: string;
  title: string;
  markdown: string;
  author_id: string;
  author_name: string;
  editor_id: string;
  editor_name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * The note projection; callers append filters and ordering.
 */
const NOTE_SELECT = `
  SELECT n.id, n.title, n.markdown, a.id AS author_id, a.display_name AS author_name,
         e.id AS editor_id, e.display_name AS editor_name, n.version, n.created_at, n.updated_at
    FROM notes n
    JOIN users a ON a.id = n.author_id
    JOIN users e ON e.id = n.last_edited_by
   WHERE n.deleted_at IS NULL`;

/**
 * Row shape of one link projection.
 */
interface LinkRow {
  note_id: string;
  type: NoteLinkType;
  id: string;
  label: string | null;
  available: number;
}

/**
 * Map a note projection row to a summary.
 *
 * @param row The row.
 * @param links The note's links.
 * @returns The summary.
 */
function toSummary(row: NoteProjectionRow, links: NoteLink[]): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    author: { id: row.author_id, displayName: row.author_name },
    links,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Map a note projection row to a full note.
 *
 * @param row The row.
 * @param links The note's links.
 * @returns The note.
 */
function toNote(row: NoteProjectionRow, links: NoteLink[]): Note {
  return {
    ...toSummary(row, links),
    markdown: row.markdown,
    lastEditedBy: { id: row.editor_id, displayName: row.editor_name }
  };
}

/**
 * Queue a guard that a link target is still live, then the link insert itself.
 *
 * @param tx The open transaction.
 * @param noteId The note.
 * @param link The target.
 * @param actorId Who linked it.
 * @param at When.
 */
function queueLink(
  tx: D1TransactionPort,
  noteId: string,
  link: NoteLinkRef,
  actorId: string,
  at: string
): void {
  tx.requireRow(sql(LIVE_TARGET_COUNT[link.type], link.id), 'NOT_FOUND');
  tx.write(
    sql(
      `INSERT INTO note_links (note_id, target_type, target_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      noteId,
      link.type,
      link.id,
      actorId,
      at
    )
  );
}

/**
 * {@link NotesRepository} over D1.
 */
export class D1NotesRepository extends D1IdempotencyReader implements NotesRepository {
  /**
   * @param port The D1 port.
   */
  constructor(private readonly port: D1Port) {
    super(port);
  }

  /**
   * @inheritdoc
   */
  async activeUser(userId: string): Promise<UserRef | null> {
    const row = await this.port.readOne<{ id: string; display_name: string }>(
      sql("SELECT id, display_name FROM users WHERE id = ? AND status = 'active'", userId)
    );
    return row === null ? null : { id: row.id, displayName: row.display_name };
  }

  /**
   * @inheritdoc
   */
  async liveTargets(refs: readonly NoteLinkRef[]): Promise<NoteLink[]> {
    const ids = (type: NoteLinkType): string =>
      JSON.stringify(refs.filter((ref) => ref.type === type).map((ref) => ref.id));
    const rows = await this.port.read<{ type: NoteLinkType; id: string; label: string }>(
      sql(LIVE_TARGETS, ids('contact'), ids('company'), ids('deal'), ids('project'))
    );
    return rows.map((row) => ({ type: row.type, id: row.id, label: row.label, available: true }));
  }

  /**
   * @inheritdoc
   */
  async getNote(id: string): Promise<Note | null> {
    const row = await this.port.readOne<NoteProjectionRow>(sql(`${NOTE_SELECT} AND n.id = ?`, id));
    if (row === null) {
      return null;
    }
    const links = await this.linksFor([row.id]);
    return toNote(row, links.get(row.id) ?? []);
  }

  /**
   * @inheritdoc
   */
  async listNotes(
    criteria: NoteListCriteria,
    linkedTo: NoteLinkRef | null
  ): Promise<Array<NoteSummary & { sortKey: string }>> {
    let text = NOTE_SELECT;
    const params: SqlValue[] = [];
    if (linkedTo !== null) {
      // Uses the reverse index `note_links_target`; FTS is not involved.
      text += ` AND EXISTS (SELECT 1 FROM note_links l
                             WHERE l.note_id = n.id AND l.target_type = ? AND l.target_id = ?)`;
      params.push(linkedTo.type, linkedTo.id);
    }
    if (criteria.after !== null) {
      text += ' AND (n.updated_at < ? OR (n.updated_at = ? AND n.id > ?))';
      params.push(criteria.after.key, criteria.after.key, criteria.after.id);
    }
    text += ' ORDER BY n.updated_at DESC, n.id LIMIT ?';
    params.push(criteria.limit + 1);
    const rows = await this.port.read<NoteProjectionRow>(sql(text, ...params));
    const links = await this.linksFor(rows.map((row) => row.id));
    return rows.map((row) => ({
      ...toSummary(row, links.get(row.id) ?? []),
      sortKey: row.updated_at
    }));
  }

  /**
   * @inheritdoc
   */
  async searchNotes(match: string, limit: number): Promise<StoredSearchHit[]> {
    // Title matches weigh five times body matches. `snippet(..., -1, ...)` picks whichever column
    // matched best; the markers are bound parameters so they cannot be confused with SQL.
    const rows = await this.port.read<NoteProjectionRow & { snippet: string; rank: number }>(
      sql(
        `SELECT n.id, n.title, n.markdown, a.id AS author_id, a.display_name AS author_name,
                e.id AS editor_id, e.display_name AS editor_name, n.version, n.created_at,
                n.updated_at, bm25(notes_fts, 5.0, 1.0) AS rank,
                snippet(notes_fts, -1, ?, ?, '…', 16) AS snippet
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           JOIN users a ON a.id = n.author_id
           JOIN users e ON e.id = n.last_edited_by
          WHERE notes_fts MATCH ? AND n.deleted_at IS NULL
          ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id
          LIMIT ?`,
        SNIPPET_OPEN,
        SNIPPET_CLOSE,
        match,
        limit
      )
    );
    const links = await this.linksFor(rows.map((row) => row.id));
    return rows.map((row) => ({
      note: toSummary(row, links.get(row.id) ?? []),
      rank: row.rank,
      snippet: row.snippet
    }));
  }

  /**
   * @inheritdoc
   */
  async history(noteId: string, limit: number): Promise<NoteDetail['history']> {
    const rows = await this.port.read<{
      id: string;
      action: string;
      actor_id: string;
      actor_name: string;
      occurred_at: string;
    }>(
      sql(
        `SELECT a.id, a.action, a.actor_id, u.display_name AS actor_name, a.occurred_at
           FROM audit_events a JOIN users u ON u.id = a.actor_id
          WHERE a.entity_type = 'note' AND a.entity_id = ?
          ORDER BY a.occurred_at DESC, a.id LIMIT ?`,
        noteId,
        limit
      )
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: { id: row.actor_id, displayName: row.actor_name },
      occurredAt: row.occurred_at
    }));
  }

  /**
   * @inheritdoc
   */
  async insertNote(write: {
    note: NoteRow;
    links: readonly NoteLinkRef[];
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { note } = write;
    await this.port.transaction((tx) => {
      tx.write(
        sql(
          `INSERT INTO notes
             (id, title, markdown, author_id, last_edited_by, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          note.id,
          note.title,
          note.markdown,
          note.authorId,
          note.lastEditedBy,
          write.at,
          write.at
        )
      );
      for (const link of write.links) {
        queueLink(tx, note.id, link, note.lastEditedBy, write.at);
      }
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * @inheritdoc
   */
  async updateNote(write: {
    note: NoteRow;
    expectedVersion: number;
    added: readonly NoteLinkRef[];
    removed: readonly NoteLinkRef[];
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void> {
    const { note } = write;
    await this.port.transaction((tx) => {
      tx.write(
        sql(
          `UPDATE notes
              SET title = ?, markdown = ?, last_edited_by = ?, version = version + 1,
                  updated_at = ?
            WHERE id = ? AND version = ? AND deleted_at IS NULL`,
          note.title,
          note.markdown,
          note.lastEditedBy,
          write.at,
          note.id,
          write.expectedVersion
        )
      );
      tx.requireChanged('VERSION_MISMATCH');
      for (const link of write.removed) {
        tx.write(
          sql(
            'DELETE FROM note_links WHERE note_id = ? AND target_type = ? AND target_id = ?',
            note.id,
            link.type,
            link.id
          )
        );
      }
      for (const link of write.added) {
        queueLink(tx, note.id, link, note.lastEditedBy, write.at);
      }
      // The at-least-one-link invariant holds at commit, not just in the request that was read.
      tx.requireRow(sql('SELECT count(*) FROM note_links WHERE note_id = ?', note.id), 'CONFLICT');
      writeEnvelope(tx, write.envelope);
      return Promise.resolve();
    });
  }

  /**
   * Every link on a set of notes, grouped by note and in display order.
   *
   * @param noteIds The notes.
   * @returns Links by note id.
   */
  private async linksFor(noteIds: readonly string[]): Promise<Map<string, NoteLink[]>> {
    const grouped = new Map<string, NoteLink[]>();
    if (noteIds.length === 0) {
      return grouped;
    }
    const rows = await this.port.read<LinkRow>(sql(LINKS_FOR_NOTES, JSON.stringify(noteIds)));
    for (const row of rows) {
      const list = grouped.get(row.note_id) ?? [];
      list.push({
        type: row.type,
        id: row.id,
        label: row.label ?? 'Unavailable record',
        available: row.available === 1
      });
      grouped.set(row.note_id, list);
    }
    for (const [noteId, list] of grouped) {
      grouped.set(noteId, sortLinksForDisplay(list));
    }
    return grouped;
  }
}
