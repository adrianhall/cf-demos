/**
 * @file Notes module use cases: multi-linked Markdown notes, linked-record feeds, and bounded
 *   full-text search. Each operation follows the shared order: validate input → authorize →
 *   (mutations) replay check → domain rules over one read snapshot → one atomic repository write
 *   including audit and idempotency rows.
 *
 *   ## One note, many links, one transaction
 *
 *   Every module shares one D1 database (specification §7.2), so the Data Worker validates every
 *   link target against the same snapshot and writes the note, all of its links, the audit event,
 *   and the idempotency result in one write set. Commit-time guards re-check that each new target
 *   still exists, so a target deleted between validation and commit rolls the note back instead of
 *   linking to it. The FTS index is maintained by triggers inside that same write set, so a failed
 *   note is never searchable. Contrast `specs/ignite-crm/microservice-experiment/01d-
 *   notesservice-spec.md` §7, where a separate Notes service had to accept pre-validated references
 *   from a composition layer.
 *
 *   ## Visibility
 *
 *   Release one has installation-wide visibility per permission: `note.read` sees every note. A
 *   link is "visible" to its author when the target exists, is not deleted, and the author holds
 *   the read permission for that record type (`crm.read` for contacts, companies, and deals;
 *   `project.read` for projects).
 */

import * as v from 'valibot';
import type { UserRef } from '../../../shared/api/crm.ts';
import {
  type CreateNoteInput,
  CreateNoteInputSchema,
  type Note,
  NoteSchema,
  type NoteDetail,
  type NoteLink,
  type NoteLinkRef,
  NoteLinkTypeSchema,
  type NoteLinkType,
  NOTE_SEARCH_LIMIT,
  type NoteSearchResult,
  NoteSearchTextSchema,
  type NoteSummary,
  type UpdateNoteInput,
  UpdateNoteInputSchema
} from '../../../shared/api/notes.ts';
import { serviceError } from '../../../shared/common/errors.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE, type Page, PageRequestSchema } from '../../../shared/common/paging.ts';
import type {
  ActorContext,
  MutationMeta,
  NoteListOptions,
  NotesPort
} from '../../../shared/data-service/contract.ts';
import type { Permission } from '../../../shared/permissions.ts';
import { VersionSchema } from '../../../shared/validation/fields.ts';
import {
  diffLinks,
  duplicateLink,
  ftsQuery,
  needsNoteManage,
  parseSnippet,
  sortLinks
} from '../../domain/notes/notes.ts';
import type { Authorizer } from '../permissions/permissions-service.ts';
import {
  type IdempotencyRepository,
  IdempotentMutation,
  type MutationEnvelope,
  requestHash
} from '../shared/mutations.ts';
import { decodeCursor, encodeCursor } from '../shared/paging.ts';
import type { Runtime } from '../shared/runtime.ts';
import { validate, validateActor, validateId, validateIdempotencyKey } from '../shared/validate.ts';

/**
 * Number of history entries returned with a note.
 */
const HISTORY_LIMIT = 20;

/**
 * The read permission that makes each linkable record type visible.
 */
const TARGET_READ: Readonly<Record<NoteLinkType, Permission>> = {
  contact: 'crm.read',
  company: 'crm.read',
  deal: 'crm.read',
  project: 'project.read'
};

/**
 * Note columns as stored.
 */
export interface NoteRow {
  /**
   * Identifier.
   */
  readonly id: string;
  /**
   * Title.
   */
  readonly title: string;
  /**
   * Raw Markdown.
   */
  readonly markdown: string;
  /**
   * Immutable author.
   */
  readonly authorId: string;
  /**
   * Last editor.
   */
  readonly lastEditedBy: string;
}

/**
 * Keyset position and size for a note list.
 */
export interface NoteListCriteria {
  /**
   * Page size.
   */
  readonly limit: number;
  /**
   * Last row of the previous page: its `updatedAt` and id.
   */
  readonly after: { readonly key: string; readonly id: string } | null;
}

/**
 * A raw search hit from storage.
 */
export interface StoredSearchHit {
  /**
   * The note.
   */
  readonly note: NoteSummary;
  /**
   * FTS5 BM25 rank (smaller is a better match).
   */
  readonly rank: number;
  /**
   * Snippet text with highlight markers (see `SNIPPET_OPEN` in the domain module).
   */
  readonly snippet: string;
}

/**
 * Storage port for the notes use cases.
 */
export interface NotesRepository extends IdempotencyRepository {
  /**
   * One active user.
   *
   * @param userId User id.
   * @returns The reference, or `null` when absent or suspended.
   */
  activeUser(userId: string): Promise<UserRef | null>;
  /**
   * The requested targets that exist and are not deleted, with their labels.
   *
   * @param refs Requested targets.
   * @returns The live ones (in any order); absent or deleted ones are omitted.
   */
  liveTargets(refs: readonly NoteLinkRef[]): Promise<NoteLink[]>;
  /**
   * Read a live note with its links.
   *
   * @param id Note id.
   * @returns The note, or `null`.
   */
  getNote(id: string): Promise<Note | null>;
  /**
   * One page of live notes, most recently updated first, optionally only those linked to a record.
   *
   * @param criteria Keyset position and size.
   * @param linkedTo Restrict to notes linked to this record.
   * @returns Up to `limit + 1` summaries with their sort keys.
   */
  listNotes(
    criteria: NoteListCriteria,
    linkedTo: NoteLinkRef | null
  ): Promise<Array<NoteSummary & { sortKey: string }>>;
  /**
   * Best full-text matches for a safe FTS expression.
   *
   * @param match An expression built by `ftsQuery` — never raw client text.
   * @param limit Maximum rows.
   * @returns Hits ordered by rank, then most recently updated, then id.
   */
  searchNotes(match: string, limit: number): Promise<StoredSearchHit[]>;
  /**
   * Recent history for a note.
   *
   * @param noteId Note id.
   * @param limit Maximum entries.
   * @returns Entries, newest first.
   */
  history(noteId: string, limit: number): Promise<NoteDetail['history']>;
  /**
   * Atomically insert a note and its links, guarding that every target still exists at commit.
   *
   * @param write The rows.
   * @returns Once committed.
   * @throws {Error} `NOT_FOUND` when a target was deleted concurrently, `CONFLICT` for a reused id
   *   or idempotency key, or `DEPENDENCY_FAILURE`.
   */
  insertNote(write: {
    note: NoteRow;
    links: readonly NoteLinkRef[];
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
  /**
   * Atomically update a note if it is still at `expectedVersion`, removing and adding links, and
   * guarding that every added target still exists at commit.
   *
   * @param write The new state and link changes.
   * @returns Once committed.
   * @throws {Error} `VERSION_MISMATCH`, `NOT_FOUND` (added target deleted), or
   *   `DEPENDENCY_FAILURE`.
   */
  updateNote(write: {
    note: NoteRow;
    expectedVersion: number;
    added: readonly NoteLinkRef[];
    removed: readonly NoteLinkRef[];
    at: string;
    envelope: MutationEnvelope;
  }): Promise<void>;
}

/**
 * Schema for note list options crossing RPC.
 */
const NoteListOptionsSchema = v.pipe(
  v.strictObject({
    linkType: v.optional(NoteLinkTypeSchema),
    linkId: v.optional(IdSchema),
    ...PageRequestSchema.entries
  }),
  v.check(
    (options) => (options.linkType === undefined) === (options.linkId === undefined),
    'linkType and linkId must be given together.'
  )
);

/**
 * Throw a validation failure keyed by field.
 *
 * @param fields Messages by field.
 * @param requestId Request identifier.
 * @returns Never.
 * @throws {Error} Always: a `VALIDATION_FAILED` service error.
 */
function invalid(fields: Record<string, string>, requestId: string): never {
  throw serviceError('VALIDATION_FAILED', 'The request contains invalid fields.', {
    requestId,
    fields
  });
}

/**
 * Format links for audit metadata: `type:id` pairs, comma-separated. Ids are not sensitive; labels
 * (customer names) are left out of audit rows.
 *
 * @param links The links.
 * @returns The text, or `null` when there are none.
 */
function auditLinks(links: readonly NoteLinkRef[]): string | null {
  return links.length === 0 ? null : links.map((link) => `${link.type}:${link.id}`).join(',');
}

/**
 * Notes application service.
 */
export class NotesService implements NotesPort {
  /**
   * @param repository Storage port.
   * @param authorizer Permissions capability.
   * @param runtime Clock and id source.
   */
  constructor(
    private readonly repository: NotesRepository,
    private readonly authorizer: Authorizer,
    private readonly runtime: Runtime
  ) {}

  /**
   * @inheritdoc
   */
  async listNotes(actor: ActorContext, options: NoteListOptions): Promise<Page<NoteSummary>> {
    const caller = validateActor(actor);
    const parsed = validate(
      NoteListOptionsSchema,
      options ?? { limit: DEFAULT_PAGE_SIZE },
      caller.requestId
    );
    const criteria: NoteListCriteria = {
      limit: parsed.limit,
      after: parsed.cursor === undefined ? null : decodeCursor(parsed.cursor, caller.requestId)
    };
    await this.authorizer.require(caller, 'note.read');
    const linkedTo =
      parsed.linkType === undefined || parsed.linkId === undefined
        ? null
        : { type: parsed.linkType, id: parsed.linkId };
    const rows = await this.repository.listNotes(criteria, linkedTo);
    const visible = rows.slice(0, criteria.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(({ sortKey: _sortKey, ...note }) => note),
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? encodeCursor(last.sortKey, last.id)
          : null
    };
  }

  /**
   * @inheritdoc
   */
  async getNote(actor: ActorContext, id: string): Promise<NoteDetail> {
    const caller = validateActor(actor);
    const noteId = validateId(id, caller.requestId);
    await this.authorizer.require(caller, 'note.read');
    const note = await this.repository.getNote(noteId);
    if (note === null) {
      throw serviceError('NOT_FOUND', 'Note not found.', { requestId: caller.requestId });
    }
    return { note, history: await this.repository.history(noteId, HISTORY_LIMIT) };
  }

  /**
   * @inheritdoc
   */
  async searchNotes(actor: ActorContext, text: string): Promise<NoteSearchResult> {
    const caller = validateActor(actor);
    const query = validate(
      v.strictObject({ q: NoteSearchTextSchema }),
      { q: text },
      caller.requestId
    );
    await this.authorizer.require(caller, 'note.read');
    const match = ftsQuery(query.q);
    if (match === null) {
      // Only punctuation: nothing searchable, so nothing matches.
      return { items: [], truncated: false };
    }
    const rows = await this.repository.searchNotes(match, NOTE_SEARCH_LIMIT + 1);
    return {
      items: rows
        .slice(0, NOTE_SEARCH_LIMIT)
        .map((row) => ({ note: row.note, rank: row.rank, snippet: parseSnippet(row.snippet) })),
      truncated: rows.length > NOTE_SEARCH_LIMIT
    };
  }

  /**
   * @inheritdoc
   */
  async createNote(actor: ActorContext, input: CreateNoteInput, meta: MutationMeta): Promise<Note> {
    const caller = validateActor(actor);
    const parsed = validate(CreateNoteInputSchema, input, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    const duplicate = duplicateLink(parsed.links);
    if (duplicate !== null) {
      invalid(duplicate, caller.requestId);
    }
    const fields = {
      title: parsed.title,
      markdown: parsed.markdown,
      links: sortLinks(parsed.links)
    };
    await this.authorizer.require(caller, 'note.write');

    const mutation = await IdempotentMutation.begin(
      'notes.createNote',
      caller,
      { idempotencyKey: key },
      fields,
      this.runtime
    );
    const replayed = await mutation.replay(this.repository, NoteSchema);
    if (replayed !== undefined) {
      return replayed;
    }
    const links = await this.requireVisibleTargets(caller, parsed.links, fields.links);
    const author = await this.self(caller);
    const now = this.runtime.now();
    const at = now.toISOString();
    const note: Note = {
      id: this.runtime.newId(),
      title: fields.title,
      markdown: fields.markdown,
      author,
      lastEditedBy: author,
      links,
      version: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.repository.insertNote({
      note: toRow(note),
      links: fields.links,
      at,
      envelope: mutation.envelope(
        note,
        [
          mutation.audit(
            'notes',
            'note',
            note.id,
            'created',
            {
              digest: await requestHash(note.markdown),
              linkCount: fields.links.length,
              linksAdded: auditLinks(fields.links)
            },
            at
          )
        ],
        now
      )
    });
    return note;
  }

  /**
   * @inheritdoc
   */
  async updateNote(
    actor: ActorContext,
    id: string,
    input: UpdateNoteInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Note> {
    const caller = validateActor(actor);
    const noteId = validateId(id, caller.requestId);
    const parsed = validate(UpdateNoteInputSchema, input, caller.requestId);
    const version = validate(VersionSchema, expectedVersion, caller.requestId);
    const key = validateIdempotencyKey(meta?.idempotencyKey, caller.requestId);
    if (parsed.links !== undefined) {
      const duplicate = duplicateLink(parsed.links);
      if (duplicate !== null) {
        invalid(duplicate, caller.requestId);
      }
    }
    const fields = {
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.markdown === undefined ? {} : { markdown: parsed.markdown }),
      ...(parsed.links === undefined ? {} : { links: sortLinks(parsed.links) })
    };
    await this.authorizer.require(caller, 'note.write');

    const mutation = await IdempotentMutation.begin(
      'notes.updateNote',
      caller,
      { idempotencyKey: key },
      { noteId, fields, version },
      this.runtime
    );
    const replayed = await mutation.replay(this.repository, NoteSchema);
    if (replayed !== undefined) {
      return replayed;
    }
    const current = await this.repository.getNote(noteId);
    if (current === null) {
      throw serviceError('NOT_FOUND', 'Note not found.', { requestId: caller.requestId });
    }
    if (needsNoteManage(current.author.id, caller.userId)) {
      await this.authorizer.require(caller, 'note.manage');
    }
    if (current.version !== version) {
      throw serviceError(
        'VERSION_MISMATCH',
        'The note was changed by someone else. Reload it and try again.',
        { requestId: caller.requestId }
      );
    }

    // Only newly added targets are validated. A kept link stays even if its target was deleted
    // since: links are history, and the note shows the target as a tombstone.
    const { added, removed } =
      fields.links === undefined
        ? { added: [], removed: [] }
        : diffLinks(current.links, fields.links);
    const addedLinks =
      added.length === 0
        ? []
        : await this.requireVisibleTargets(
            caller,
            // Report problems against the caller's own indexes in the submitted list.
            parsed.links ?? [],
            added
          );
    const removedKeys = new Set(removed.map((link) => `${link.type}:${link.id}`));
    const links = sortLinksForDisplay([
      ...current.links.filter((link) => !removedKeys.has(`${link.type}:${link.id}`)),
      ...addedLinks
    ]);

    const editor = await this.self(caller);
    const now = this.runtime.now();
    const at = now.toISOString();
    const note: Note = {
      ...current,
      title: fields.title ?? current.title,
      markdown: fields.markdown ?? current.markdown,
      lastEditedBy: editor,
      links,
      version: current.version + 1,
      updatedAt: at
    };
    await this.repository.updateNote({
      note: toRow(note),
      expectedVersion: version,
      added,
      removed,
      at,
      envelope: mutation.envelope(
        note,
        [
          mutation.audit(
            'notes',
            'note',
            noteId,
            'updated',
            {
              fields: Object.keys(fields).sort().join(','),
              titleChanged: note.title !== current.title,
              digest: await requestHash(note.markdown),
              linkCount: links.length,
              linksAdded: auditLinks(added),
              linksRemoved: auditLinks(removed),
              version: note.version
            },
            at
          )
        ],
        now
      )
    });
    return note;
  }

  /**
   * Check that the caller may see every requested target, and that each exists.
   *
   * @param caller The caller.
   * @param submitted The links as submitted, so errors name the caller's own indexes.
   * @param wanted The targets to check.
   * @returns The targets with labels, in display order.
   * @throws {Error} `FORBIDDEN` when the caller cannot read a target type, or `VALIDATION_FAILED`
   *   naming each target that does not exist or has been deleted.
   */
  private async requireVisibleTargets(
    caller: ActorContext,
    submitted: readonly NoteLinkRef[],
    wanted: readonly NoteLinkRef[]
  ): Promise<NoteLink[]> {
    for (const permission of new Set(wanted.map((link) => TARGET_READ[link.type]))) {
      await this.authorizer.require(caller, permission);
    }
    const found = await this.repository.liveTargets(wanted);
    const live = new Set(found.map((link) => `${link.type}:${link.id}`));
    const missing: Record<string, string> = {};
    for (const [index, link] of submitted.entries()) {
      const key = `${link.type}:${link.id}`;
      if (!live.has(key) && wanted.some((item) => `${item.type}:${item.id}` === key)) {
        missing[`links.${index}`] = 'This record does not exist or is no longer available.';
      }
    }
    if (Object.keys(missing).length > 0) {
      invalid(missing, caller.requestId);
    }
    return sortLinksForDisplay(found);
  }

  /**
   * The caller as a user reference.
   *
   * @param caller The caller.
   * @returns The reference (the e-mail stands in if the user was suspended mid-request; the write
   *   would then fail its foreign key anyway).
   */
  private async self(caller: ActorContext): Promise<UserRef> {
    return (
      (await this.repository.activeUser(caller.userId)) ?? {
        id: caller.userId,
        displayName: caller.email
      }
    );
  }
}

/**
 * Compare two strings by UTF-16 code unit. Deliberately not `localeCompare`, whose ICU data can
 * differ between workerd and Node, so the order a note is returned in never depends on runtime.
 *
 * @param a First string.
 * @param b Second string.
 * @returns Negative, zero, or positive.
 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order links for display: by type (contact, company, deal, project), then lower-cased label, then
 * id. The repository sorts read links with this same function, so a note looks identical whether it
 * was just written or read back.
 *
 * @param links The links.
 * @returns A sorted copy.
 */
export function sortLinksForDisplay(links: readonly NoteLink[]): NoteLink[] {
  const order = NoteLinkTypeSchema.options;
  return [...links].sort(
    (a, b) =>
      order.indexOf(a.type) - order.indexOf(b.type)
      || compareText(a.label.toLowerCase(), b.label.toLowerCase())
      || compareText(a.id, b.id)
  );
}

/**
 * Project a note onto its stored columns.
 *
 * @param note The note.
 * @returns The row.
 */
function toRow(note: Note): NoteRow {
  return {
    id: note.id,
    title: note.title,
    markdown: note.markdown,
    authorId: note.author.id,
    lastEditedBy: note.lastEditedBy.id
  };
}
