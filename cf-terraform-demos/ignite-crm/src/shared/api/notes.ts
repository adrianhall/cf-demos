/**
 * @file Notes wire schemas: Markdown knowledge documents linked to many business records, their
 *   linked-record feeds, and bounded full-text search. As with the other `src/shared/api` modules,
 *   the same values cross the Data Worker RPC boundary unchanged, and request schemas are
 *   `strictObject`s so server-owned fields (`author`, `version`, link labels) cannot be smuggled
 *   into a body. A note is **not** a CRM activity and has no single parent: it links to any mix of
 *   contacts, companies, deals, and projects (specification §6.1, §7.2). Raw Markdown is the
 *   canonical, stored form; rendered HTML is produced only in the browser, with HTML disabled (see
 *   `src/client/services/markdown.ts`).
 */

import * as v from 'valibot';
import { TimestampSchema } from '../common/dates.ts';
import { IdSchema } from '../common/ids.ts';
import { CursorSchema, MAX_PAGE_SIZE, pageSchema } from '../common/paging.ts';
import { requiredText } from '../validation/fields.ts';
import { HistoryEntrySchema, UserRefSchema } from './crm.ts';

/**
 * Record types a note may link to, in display order.
 */
export const NOTE_LINK_TYPES = ['contact', 'company', 'deal', 'project'] as const;

/**
 * Schema for a link target type.
 */
export const NoteLinkTypeSchema = v.picklist(
  NOTE_LINK_TYPES,
  'Link type must be contact, company, deal, or project.'
);

/**
 * A link target type.
 */
export type NoteLinkType = v.InferOutput<typeof NoteLinkTypeSchema>;

/**
 * Largest Markdown body, in UTF-8 bytes after newline normalization (64 KiB).
 */
export const NOTE_MARKDOWN_MAX_BYTES = 64 * 1024;

/**
 * Most links on one note. A meeting note touches a handful of records; the bound keeps the write
 * set, the guard list, and the link chooser predictable.
 */
export const NOTE_LINK_LIMIT = 20;

/**
 * Most hits one search returns. Release one has installation-wide note visibility, so a capped FTS
 * page needs no per-row authorization filter (see `01d-notesservice-spec.md` §6).
 */
export const NOTE_SEARCH_LIMIT = 50;

/**
 * Shortest and longest search text accepted.
 */
export const NOTE_SEARCH_MIN = 2;

/**
 * Longest search text accepted.
 */
export const NOTE_SEARCH_MAX = 200;

/**
 * Normalise every line ending to `\n`, so the byte limit and the stored text do not depend on the
 * author's operating system.
 *
 * @param text Raw text.
 * @returns The text with `\r\n` and lone `\r` replaced by `\n`.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

/**
 * Number of UTF-8 bytes in a string.
 *
 * @param text The text.
 * @returns Its encoded length.
 */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Schema for a Markdown body: newline-normalised, non-blank, at most 64 KiB of UTF-8.
 */
export const NoteMarkdownSchema = v.pipe(
  v.string('Body must be text.'),
  v.transform(normalizeNewlines),
  v.check((text) => text.trim() !== '', 'Body is required.'),
  v.check((text) => !/[\uE000\uE001]/u.test(text), 'Body contains unsupported characters.'),
  v.check(
    (text) => utf8Length(text) <= NOTE_MARKDOWN_MAX_BYTES,
    `Body must be at most ${NOTE_MARKDOWN_MAX_BYTES / 1024} KiB.`
  )
);

/**
 * A requested link: just the target's type and id. Labels and availability are server-owned.
 */
export const NoteLinkRefSchema = v.strictObject({
  /**
   * Target record type.
   */
  type: NoteLinkTypeSchema,
  /**
   * Target record id.
   */
  id: IdSchema
});

/**
 * A requested link.
 */
export type NoteLinkRef = v.InferOutput<typeof NoteLinkRefSchema>;

/**
 * Schema for a note's requested links: one to {@link NOTE_LINK_LIMIT}. Duplicates are a domain rule
 * (see `src/data-worker/domain/notes/notes.ts`), so every transport reports them identically.
 */
export const NoteLinkListSchema = v.pipe(
  v.array(NoteLinkRefSchema, 'Links must be a list.'),
  v.minLength(1, 'Link the note to at least one record.'),
  v.maxLength(NOTE_LINK_LIMIT, `A note can link to at most ${NOTE_LINK_LIMIT} records.`)
);

/**
 * A link as read back: the target plus its current label.
 */
export const NoteLinkSchema = v.strictObject({
  /**
   * Target record type.
   */
  type: NoteLinkTypeSchema,
  /**
   * Target record id.
   */
  id: IdSchema,
  /**
   * The target's current name or title.
   */
  label: v.string(),
  /**
   * `false` once the target has been deleted. The link is kept — links are history — but the UI
   * shows it as a tombstone rather than a navigable link.
   */
  available: v.boolean()
});

/**
 * A link as read back.
 */
export type NoteLink = v.InferOutput<typeof NoteLinkSchema>;

/**
 * A note without its body: what lists, feeds, and search hits show.
 */
export const NoteSummarySchema = v.strictObject({
  /**
   * Note identifier.
   */
  id: IdSchema,
  /**
   * Title.
   */
  title: v.string(),
  /**
   * Immutable author.
   */
  author: UserRefSchema,
  /**
   * Linked records, ordered by type (contact, company, deal, project) then label.
   */
  links: v.array(NoteLinkSchema),
  /**
   * Optimistic-concurrency version, shared by text and link changes.
   */
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * Creation instant.
   */
  createdAt: TimestampSchema,
  /**
   * Last modification instant.
   */
  updatedAt: TimestampSchema
});

/**
 * A note summary.
 */
export type NoteSummary = v.InferOutput<typeof NoteSummarySchema>;

/**
 * A full note.
 */
export const NoteSchema = v.strictObject({
  ...NoteSummarySchema.entries,
  /**
   * Canonical raw Markdown. Never HTML; the browser renders it with HTML disabled.
   */
  markdown: v.string(),
  /**
   * Who last changed the text or links.
   */
  lastEditedBy: UserRefSchema
});

/**
 * A full note.
 */
export type Note = v.InferOutput<typeof NoteSchema>;

/**
 * A note with its history.
 */
export const NoteDetailSchema = v.strictObject({
  /**
   * The note.
   */
  note: NoteSchema,
  /**
   * Most recent history entries, newest first. Audit rows hold a content digest, never the body.
   */
  history: v.array(HistoryEntrySchema)
});

/**
 * A note detail projection.
 */
export type NoteDetail = v.InferOutput<typeof NoteDetailSchema>;

/**
 * One page of note summaries, most recently updated first.
 */
export const NotePageSchema = pageSchema(NoteSummarySchema);

/**
 * One run of snippet text: matched or not. Snippets are plain text; the browser renders matched
 * runs with `<mark>` through ordinary text interpolation, so note content is never parsed as HTML.
 */
export const SnippetSegmentSchema = v.strictObject({
  /**
   * Plain text.
   */
  text: v.string(),
  /**
   * Whether this run matched a search term.
   */
  match: v.boolean()
});

/**
 * One snippet run.
 */
export type SnippetSegment = v.InferOutput<typeof SnippetSegmentSchema>;

/**
 * One search hit.
 */
export const NoteSearchHitSchema = v.strictObject({
  /**
   * The matching note.
   */
  note: NoteSummarySchema,
  /**
   * FTS5 BM25 rank (smaller is a better match). Title terms weigh five times body terms.
   */
  rank: v.number(),
  /**
   * A short excerpt around the best match, as plain-text runs with explicit match flags.
   */
  snippet: v.array(SnippetSegmentSchema)
});

/**
 * One search hit.
 */
export type NoteSearchHit = v.InferOutput<typeof NoteSearchHitSchema>;

/**
 * A bounded search result: best match first (BM25 rank, then most recently updated, then id), at
 * most {@link NOTE_SEARCH_LIMIT} hits.
 */
export const NoteSearchResultSchema = v.strictObject({
  /**
   * The hits.
   */
  items: v.pipe(v.array(NoteSearchHitSchema), v.maxLength(NOTE_SEARCH_LIMIT)),
  /**
   * Whether more notes matched than were returned.
   */
  truncated: v.boolean()
});

/**
 * A search result.
 */
export type NoteSearchResult = v.InferOutput<typeof NoteSearchResultSchema>;

/**
 * Schema for search text: trimmed, 2–200 characters. The text is tokenized server-side; it is never
 * passed to FTS as a query expression.
 */
export const NoteSearchTextSchema = v.pipe(
  v.string('Search text must be text.'),
  v.trim(),
  v.minLength(NOTE_SEARCH_MIN, `Search for at least ${NOTE_SEARCH_MIN} characters.`),
  v.maxLength(NOTE_SEARCH_MAX, `Search text must be at most ${NOTE_SEARCH_MAX} characters.`)
);

/**
 * Request body for creating a note.
 */
export const CreateNoteInputSchema = v.strictObject({
  /**
   * Title.
   */
  title: v.pipe(
    requiredText('Title', 200),
    v.check((text) => !/[\uE000\uE001]/u.test(text), 'Title contains unsupported characters.')
  ),
  /**
   * Markdown body.
   */
  markdown: NoteMarkdownSchema,
  /**
   * Records to link (at least one).
   */
  links: NoteLinkListSchema
});

/**
 * A validated create-note request.
 */
export type CreateNoteInput = v.InferOutput<typeof CreateNoteInputSchema>;

/**
 * Request body for updating a note. Omitted fields are unchanged; `links` replaces the whole set.
 */
export const UpdateNoteInputSchema = v.pipe(
  v.strictObject({
    /**
     * New title.
     */
    title: v.optional(
      v.pipe(
        requiredText('Title', 200),
        v.check((text) => !/[\uE000\uE001]/u.test(text), 'Title contains unsupported characters.')
      )
    ),
    /**
     * New Markdown body.
     */
    markdown: v.optional(NoteMarkdownSchema),
    /**
     * Replacement link set (at least one).
     */
    links: v.optional(NoteLinkListSchema)
  }),
  v.check((input) => Object.keys(input).length > 0, 'Provide at least one field to change.')
);

/**
 * A validated update-note request.
 */
export type UpdateNoteInput = v.InferOutput<typeof UpdateNoteInputSchema>;

/**
 * Query string for listing notes, optionally only those linked to one record.
 */
export const NoteListQuerySchema = v.pipe(
  v.strictObject({
    /**
     * Linked record type; requires `linkId`.
     */
    linkType: v.optional(NoteLinkTypeSchema),
    /**
     * Linked record id; requires `linkType`.
     */
    linkId: v.optional(IdSchema),
    /**
     * Page size, 1–100.
     */
    limit: v.optional(
      v.pipe(
        v.string(),
        v.regex(/^\d{1,3}$/u, 'limit must be a whole number.'),
        v.transform(Number),
        v.minValue(1, 'limit must be at least 1.'),
        v.maxValue(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}.`)
      )
    ),
    /**
     * Cursor from the previous page.
     */
    cursor: v.optional(CursorSchema)
  }),
  v.check(
    (query) => (query.linkType === undefined) === (query.linkId === undefined),
    'linkType and linkId must be given together.'
  )
);

/**
 * Query string for searching notes.
 */
export const NoteSearchQuerySchema = v.strictObject({
  /**
   * Search text.
   */
  q: NoteSearchTextSchema
});
