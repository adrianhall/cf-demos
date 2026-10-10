# Ignite CRM — Notes service specification

## 1. Purpose and boundary

The Notes service owns Markdown knowledge documents, typed links from one note to many CRM/project
records, note-to-note links when enabled, full-text search, and note audit history. Notes are not
CRM activities and do not belong to one parent.

It does not own linked records, render trusted HTML, schedule meetings, perform LLM summarization,
or provide a general Notion database/Obsidian graph.

## 2. Architecture and dependencies

```text
NotesEntrypoint
  → NotesApplicationService
    → Note / NoteLink domain
    → NoteRepository / SearchRepository ports → NOTES_DB + FTS5
    → PermissionsPort (required)
```

Target validation is composed before `createNote` by API/MCP, using CRM and Projects. Notes accepts
`ValidatedResourceRef` only. It does not bind CRM/Projects, avoiding reverse cycles and allowing
independent operation. It binds only `PERMISSIONS` and `NOTES_DB`.

## 3. RPC contract

```ts
export abstract class NotesContract {
  abstract health(): Promise<Health>;
  abstract getNote(actor: ActorContext, id: string): Promise<Note>;
  abstract listNotes(
    actor: ActorContext,
    query: NoteQuery,
    page: PageRequest
  ): Promise<Page<NoteSummary>>;
  abstract searchNotes(
    actor: ActorContext,
    query: NoteSearchQuery,
    page: PageRequest
  ): Promise<Page<NoteSearchHit>>;
  abstract createNote(
    actor: ActorContext,
    input: CreateNoteInput,
    meta: MutationMeta
  ): Promise<Note>;
  abstract updateNote(
    actor: ActorContext,
    id: string,
    input: UpdateNoteInput,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Note>;
  abstract replaceLinks(
    actor: ActorContext,
    id: string,
    links: readonly ValidatedResourceRef[],
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<Note>;
  abstract deleteNote(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    meta: MutationMeta
  ): Promise<DeletionResult>;
  abstract listLinksTo(
    actor: ActorContext,
    ref: ResourceRef,
    page: PageRequest
  ): Promise<Page<NoteSummary>>;
  abstract listAudit(
    actor: ActorContext,
    filter: AuditFilter,
    page: PageRequest
  ): Promise<Page<NoteAuditEvent>>;
  abstract validateResourceRefs(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ValidatedResourceRef[]>;
  abstract getResourceLabels(
    actor: ActorContext,
    refs: readonly ResourceRef[]
  ): Promise<readonly ResourceLabel[]>;
}
```

`validateResourceRefs` here accepts only `note` references and supports the Could-have note-to-note
feature. For release-one Must-have links, API calls CRM/Projects validators.

`ValidatedResourceRef` includes type, ID, validator service, validation request ID, and actor ID. It
is a plain internal value, short-lived for one composition request, never stored except type/ID. It
is not a cryptographic capability: Notes verifies actor ID and duplicates, while API/MCP are
responsible for constructing it only from owner-service results. Public schemas cannot contain its
validator fields, and tests enforce that boundary.

## 4. Domain model

### Note

`Note`: `id`, `title`, `markdown`, `authorId`, `lastEditedBy`, `links[]`, `version`, `createdAt`,
`updatedAt`, optional deletion metadata.

- Title 1–200. Markdown 1 byte–64 KiB UTF-8 after newline normalization.
- Raw Markdown is canonical. Rendered HTML is not stored.
- HTML inside Markdown is disabled. UI supports headings, emphasis, lists, links, fenced code, and
  task-list checkboxes. Checkbox changes edit the note; they do not create Project tasks.
- A note requires at least one link in release one. Links may target multiple contacts, companies,
  deals, projects, and (Could-have) notes.
- Author is immutable. Last editor changes on update. Unknown fields are rejected.
- Updating text or replacing links increments one shared version.

### Links

A typed link is unique `(note_id,target_type,target_id)`. Links have `created_by/created_at`.
Removing a link physically deletes the join row but is captured in the note audit event. A target's
later soft deletion does not remove the link.

### Search

D1 FTS5 indexes note title and Markdown body. Search:

- accepts 2–200 characters;
- escapes user text into a safe prefix-token query; no raw FTS syntax from clients;
- returns snippets with highlight offsets/escaped text, rank, links, and note metadata;
- filters authorization before returning results (release one role visibility is installation-wide);
- orders by BM25 rank then `updated_at DESC, id` and caps at 50.

Search by linked target uses the link table first and does not require FTS.

## 5. D1 schema

### `notes`

`id`, `title`, `markdown`, `author_id`, `last_edited_by`, `version`, timestamps/deletion. Indexes on
`(updated_at DESC,id)`, `author_id`, deletion.

### `note_links`

`note_id`, `target_type` CHECK known enum, `target_id`, `created_by`, `created_at`, primary key on
all three identity fields. Reverse index `(target_type,target_id,note_id)`.

There are no cross-database foreign keys for CRM/project IDs. Note-to-note links are locally checked
when enabled.

### FTS5

`notes_fts(title, markdown, content='notes', content_rowid='rowid')` with insert/update/delete
triggers. Migrations rebuild FTS after schema changes and tests assert parity between active `notes`
and FTS rows. Deleted notes are removed from FTS by trigger.

### Supporting

`audit_events`, `idempotency_records` per system spec. Audit stores title/link diffs and a SHA-256
content digest, not full note body, to avoid duplicating sensitive text. Version history is not a
Must-have; current content only is retained.

## 6. Authorization and security

- `note.read`: get/list/search/listLinks.
- `note.write`: create and update/replace links/delete one's own notes.
- `note.manage`: owner/manager may update/delete any note. Other writers require `note.write` and
  `actor.userId === note.authorId`; Notes asks Permissions for `note.manage` rather than inspecting
  roles.
- Target visibility is proven by the composition layer before link creation. Notes rechecks
  `note.write` but cannot and must not infer target visibility itself.
- Markdown URLs allow `https`, `http`, and `mailto`; reject `javascript`, `data`, `file`. External
  links render with safe `rel` values. HTML remains disabled and final rendering is sanitized.
- `audit.read` gates `listAudit`.
- `replaceLinks([])` is `INVALID_ARGUMENT`; the at-least-one-link invariant is transactional.
- Search logs query length and result count, never query text or note content. The 50-result bound
  is correct because release one has installation-wide note visibility; any future row-level privacy
  must move authorization into the query rather than post-filter a capped FTS page.

## 7. Failure and consistency behavior

Create/update/link/audit/idempotency/FTS trigger effects are one D1 transaction. If target
validation fails or a dependency is unavailable, the composition layer never calls Notes. If a
target is deleted after validation but before note commit, the link may be created; this is accepted
because links are historical and deletion produces a tombstone. No distributed lock is attempted.

Hydrating link labels occurs in API/MCP after Notes returns. CRM/Projects outage may yield partial
labels on reads, but never hides the note itself when `note.read` is authorized.

## 8. Independent testing

### Pure unit

Markdown/title limits, newline normalization, URL policy, link dedupe/sort, empty-link rejection,
ownership/manage policy, search query tokenization/escaping, cursor/rank order.

### Application with fakes

Repositories, PermissionsPort, clock, IDs. Test permissions/outage, validated actor mismatch, target
mix, optimistic concurrency, idempotency, audit digest, tombstones, and partial hydration
independence.

### D1/FTS adapter

Apply Notes migrations; test triggers on create/update/delete, Unicode search, injection-like FTS
input, snippets, ranking tie-break, reverse-link query, soft-delete exclusion, transaction rollback.
D1 officially supports FTS5; tests run in workerd, not a Node SQLite substitute.

### Contract and integration

- `notesContractTests` runs against real entrypoint and `FakeNotesService` used by API/MCP.
- Real Notes + fake Permissions covers denial/outage.
- API integration uses real CRM/Projects validators + real Notes for one note linked to two
  contacts, company, deal, and project; all contexts return the same note ID.
- Delete linked CRM target and assert the note remains with tombstoned context.

## 9. Acceptance criteria

- One canonical note supports many typed links without duplicated text.
- Search finds title/body and never accepts raw client FTS expressions.
- Notes is independently testable without CRM or Projects.
- Link target validation is explicit and cannot be forged through the public API/MCP.
- Raw Markdown cannot execute HTML/script in the SPA.

## 10. Open questions

1. Must a note always have at least one business-record link? Current decision: yes. Allowing a
   personal/unfiled inbox would change product scope.
2. Should note-to-note links ship (Could-have) or remain disabled in release one?
3. Is lightweight version history required? Current decision: no; audit stores metadata/digest, not
   full historical content.
4. Should non-manager authors be the only editors of their notes (current decision), or should every
   `note.write` user collaborate on all notes?
5. Should task-list checkboxes be interactive in rendered notes? Current decision: yes, as an
   optimistic note update; they never create project tasks.
6. Confirm 64 KiB maximum and FTS search minimum of two characters.
