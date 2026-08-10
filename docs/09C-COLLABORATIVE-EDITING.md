# Demo 9C: Architect Collaborative Editing

Directory: `demos/architect` (extends [Demo 9](./09-ARCHITECT.md) and
[Demo 9B](./09B-ARCHITECT-MCP.md) — same demo, same domain, no new deployable unit)

Domain: `architect.cfapps.uk` (unchanged)

Status: Draft implementation plan — no code exists yet. Requires
[Demo 9](./09-ARCHITECT.md)'s Phases 0–10 (catalog, editor, dashboard, sharing, admin, export,
accessibility fixes) **and** [Demo 9B](./09B-ARCHITECT-MCP.md)'s Phases 11–15 (remote MCP server,
`DiagramSession` Durable Object, the shared graph-mutation service) already shipped. This is the
"future collaboration... specification" `docs/09-ARCHITECT.md`'s
[Post-MVP section](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) and
`docs/BACKLOG.md`'s original demo 9 write-up both point at. It does not revisit anything Demo 9 or
9B already decided (Access application/policy shape, D1 core schema, anonymous read-only sharing,
admin authorization, the MCP tool catalog) except where explicitly called out below, and it
extends `DiagramSession` in place rather than introducing a second per-diagram Durable Object —
see [Reuse `DiagramSession`](./09-ARCHITECT.md#reuse-diagramsession--do-not-design-a-second-per-diagram-durable-object),
which this document fulfills.

Cloudflare products added by this follow-on: none. Every product this document needs — Durable
Objects, D1, and Workers Access — is already provisioned by Demo 9 and 9B, and **D1 stays the
diagram's one and only durable copy**, exactly as it already is in Demo 9 — `DiagramSession` never
gains a second, independently-persisted copy of a diagram's graph (see
[Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)). This document is entirely an
application-layer and Durable-Object-internals change, not an infrastructure change — see
[Infrastructure Changes](#infrastructure-changes).

**Out of scope, deliberately:** AI-generated architecture proposals — the other half of
`docs/09-ARCHITECT.md`'s Post-MVP section — are a separate, unrelated capability (Workflows,
Workers AI) with their own design questions and get their own future document if and when they
are scoped. Nothing below depends on or blocks that work.

## Summary

Demo 9 shipped a single-user diagram editor. Demo 9B added a way for one signed-in user's own
external AI agent to edit that same user's own diagrams, plus a **read-only** live-push channel
so an open browser tab sees the agent's edits instantly. This document is the third and final
piece the original `docs/BACKLOG.md` demo 9 write-up asked for: **two different signed-in humans
editing the same diagram at the same time, each seeing the other's cursor and edits live** — the
capability every other section of Demo 9 and 9B explicitly deferred.

Three things change to get there:

1. **A minimal, owner-managed collaborator model.** A diagram's owner grants edit access to
   other specific, already-known Access identities — reusing Demo 9's own `users` directory
   (people who have signed in through this same Access application at least once), never an
   open-ended invite-by-any-email flow. This is genuinely new: Demo 9's only existing sharing
   primitive is the anonymous, read-only share link (`docs/09-ARCHITECT.md` Phase 3), which stays
   completely unchanged and untouched — it answers a different question ("let anyone with this
   link *view* the current diagram") from the one this document answers ("let this specific
   person *edit* it too"). See [Collaborator Model](#collaborator-model).
2. **`DiagramSession` becomes bidirectional, but D1 stays the only place a diagram's graph is
   durably stored.** 9B's Durable Object was deliberately push-only and stateless ("holds no
   durable data of its own... D1 remains the single source of truth"). Real multi-human editing
   needs the reverse direction (a client's own edits arrive *into* the object, not just push *out*
   of it), which this document adds — but it deliberately does **not** answer 9B's Post-MVP
   question ("where the authoritative graph lives... is not a decision this reuse forces one way
   or the other, but it is still a decision the future collaboration spec must make explicitly")
   by giving the object its own persisted copy. It answers it the other way: D1 remains the
   diagram's one authoritative, durably-stored copy at every moment, including while a live
   session is active, and `DiagramSession` holds only an ordinary, disposable in-memory cache of
   it — see [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy) for why that is both simpler
   and *more* correct than the alternative for this demo, not merely more convenient.
3. **9B's whole-graph, last-write-wins model is replaced by 9B's own granular operation
   vocabulary**, broadcast and applied one operation at a time instead of one whole-graph replace
   at a time — exactly the upgrade 9B's Post-MVP note already recommended ("a materially better
   foundation for multi-human collaboration than 09B's own explicitly-scoped-down whole-graph,
   last-write-wins model"). No CRDT and no operational-transform library are introduced; see
   [Why Not A CRDT](#why-not-a-crdt) for why a Durable Object's own execution model makes that
   unnecessary at this granularity.

Every other Demo 9/9B decision — the Access application and policy, D1's core `diagrams`/`users`
tables, the anonymous share-link model, admin authorization, the MCP tool catalog and its Managed
OAuth authentication — is reused completely unchanged.

## Prerequisites

- `docs/09-ARCHITECT.md` Phases 0–10 and `docs/09B-ARCHITECT-MCP.md` Phases 11–15 implemented and
  deployed. In particular, this document assumes `DiagramSession`
  (`src/worker/diagram-session/diagram-session.ts`), `src/worker/diagrams/graph-mutations.ts`,
  `GET /api/diagrams/:id/live`, and the `DIAGRAM_SESSIONS` Durable Object binding (already
  `new_sqlite_classes`-migrated by 9B) all already exist exactly as 9B specifies.
- Re-verify Durable Object in-memory-state and hibernation semantics against current Cloudflare
  documentation before implementing — the design below leans specifically on a Durable Object
  having exactly one active JS instance per diagram id at a time, and on the fact that
  synchronous, non-`await`-ing JS code cannot be interleaved by an incoming event, however that
  in-memory state is **not** durable and is discarded whenever hibernation evicts the instance
  (see [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)). This repository's
  `durable-objects` skill is a starting point, not a substitute for the live API reference, per
  this repository's standing retrieval-over-pre-training rule.
- Confirm the `testing-durable-objects` skill's guidance (serialize test files that open real
  WebSockets, re-create schema after `deleteAll()`, never gate on a client-initiated close) still
  matches current `@cloudflare/vitest-pool-workers` behavior — this document's testing needs are a
  strict superset of 9B's, since it now needs **two or more simultaneous simulated clients** per
  test, not one.

## Goals

- Let a diagram's owner grant a specific, already-known colleague edit access to that diagram,
  without building a new invitation or identity system.
- Make two authenticated editors' changes to the same diagram visible to each other **live**,
  including remote cursor position and who is currently connected — the specific behavior
  `docs/BACKLOG.md`'s original demo 9 write-up asked for ("each user sees the cursor of the other
  user").
- Make concurrent edits correct — no lost updates, no corrupted graph — using the Durable Object
  execution model itself as the correctness mechanism, not a hand-rolled or third-party
  conflict-resolution library.
- Reuse 9B's `DiagramSession`, `graph-mutations.ts`, and MCP tool catalog rather than forking or
  duplicating them; unify the MCP write path and the human write path onto one code path inside
  the Durable Object, closing the gap 9B's own Post-MVP note left open.

## Non-Goals

- **Character-level real-time text editing.** A node's `label`/`description` fields (and an
  edge's `label`/`description`/`protocol` fields) are edited the same way Demo 9 already edits
  them — typed into a `PropertiesPanel` field, committed on a short debounce — not streamed
  keystroke-by-keystroke to other viewers. Two editors typing into the same field around the same
  moment is resolved by whichever `update_node`/`update_edge` operation the Durable Object
  happens to apply last (see [Concurrency Model](#concurrency-model)), surfaced to the other
  editor as a brief "Updated by \<name\>" toast — the same toast mechanism 9B already introduced
  for agent-driven edits, reused rather than duplicated, not a merged/interleaved result of both
  edits. This is a deliberate, narrow scope cut: `docs/BACKLOG.md`'s own curriculum principles
  defer "collaborative code editing" specifically *because* character-level conflict resolution
  "obscures the basic Durable Object and WebSocket lesson" — that reasoning is why this document
  stops at node/edge-level operations and does not reach for a CRDT or OT library to go further.
- **A collaborator role system beyond owner/editor.** Every collaborator this document adds can
  edit the whole diagram; there is no read-only authenticated collaborator, no per-node
  permission, and no reviewer/approval role. A view-only *authenticated* collaborator role is a
  reasonable future extension but is not built here — Demo 9's existing anonymous read-only share
  link already covers "let someone view this without editing," and duplicating that as a second,
  authenticated-only viewer role would add a third sharing concept with no new teaching value.
- **Inviting an identity that has never signed in.** Adding a collaborator requires that email to
  already exist in Demo 9's `users` directory (i.e., that person has opened this Access
  application at least once). This document does not add an email-invitation flow — that would
  require the `cloudflare-email-service` skill's product surface for a small, orthogonal feature,
  and Demo 9 already establishes the precedent of handing off access "out of band" (the owner
  copies and sends the anonymous share link themselves; here, the owner tells their colleague to
  sign in once, then adds them by email). See [Collaborator Model](#collaborator-model).
- **Locking, reservations, or "someone is editing this node" enforcement.** Presence surfaces who
  is connected and, as a light touch, which node/edge they currently have selected — advisory
  only. Nothing prevents two editors from mutating the same node at once; see
  [Concurrency Model](#concurrency-model) for why that is an acceptable, and clearly documented,
  scope boundary rather than a gap discovered later.
- **Rewriting 9B's Access Model, MCP tool catalog, or Managed OAuth setup.** No new Access
  application, no new Access policy, no new Terraform resource of any kind — every destination
  this document's new routes and the existing live-sync WebSocket route need is already covered
  by 9's `app` Access application's existing `/api/diagrams*` destination. See
  [Access Model](#access-model).
- **AI-generated proposals.** See [Summary](#summary) — a separate, unrelated future document.

## Access Model

No changes. Every new route this document adds (`/api/diagrams/:id/collaborators`,
`/api/diagrams/shared-with-me`) sits under `/api/diagrams*`, already one of `infra/access.tf`'s
`app` Access application's four existing destinations (`/app*`, `/api/me`, `/api/diagrams*`,
`/api/admin*`), backed by the same `authenticated_users` policy (any authenticated identity).
`GET /api/diagrams/:id/live` (9B) is likewise already covered. **No new Access application, no new
policy, no new destination, no Terraform diff at all.**

Authorization for *which* diagrams a given identity may read or write is, as it already is in
Demo 9, an **application-layer** concern the Worker enforces on top of Access's "is this a
verified identity" guarantee — Access answers "who is this," Demo 9's repositories answer "what
can they touch." This document only changes the second half: `DiagramRepository.findOwned(id,
ownerEmail)` — "does this diagram exist and does this exact identity own it" — gains a sibling,
`findAccessible(id, email)`, that also returns a diagram a caller has been explicitly added to as
a collaborator, annotated with which role applies. See
[Collaborator Model](#collaborator-model) for exactly which existing routes switch to it and which
stay owner-only.

## Collaborator Model

### Data Model

One new D1 table, added as a plain, Wrangler-run migration exactly like Demo 9 Phase 3's own
`diagram_shares` table (`demos/architect/migrations/0002_create_diagram_shares.sql`) — no
Terraform involvement, per this repository's convention that Terraform owns the D1 *database*
resource, not its table schema:

```sql
-- Authenticated edit-collaboration (docs/09C-COLLABORATIVE-EDITING.md). Distinct from
-- diagram_shares (docs/09-ARCHITECT.md Phase 3): a share link grants anonymous, read-only,
-- unauthenticated access; a collaborator row grants a specific, already-known Access identity
-- full edit access. collaborator_email must already exist in `users` (i.e. that identity has
-- signed in through this Access application at least once) -- enforced by the repository, not a
-- foreign key, since `users` has no enforced-unique constraint beyond its own primary key that
-- SQLite could reference cleanly alongside diagram_id's own lack of a `diagrams` FK (Demo 9 never
-- added one there either, for the same D1/SQLite-pragma reasons -- see that migration).
CREATE TABLE diagram_collaborators (
  diagram_id TEXT NOT NULL,
  collaborator_email TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (diagram_id, collaborator_email)
);

CREATE INDEX diagram_collaborators_email_idx ON diagram_collaborators (collaborator_email);
```

`added_by` (the owner's email at the time of grant) exists purely as an audit trail — no route
ever reads it back — and costs nothing to keep.

### Repository And Validation

A new `src/worker/collaborators/{repository,types,validation}.ts` module, mirroring 9's own
`src/worker/shares/` module shape exactly (one repository class, one types file, one validation
file — see AGENTS.md's Source Organization):

| Method | Behavior |
| --- | --- |
| `CollaboratorRepository.add(diagramId, ownerEmail, collaboratorEmail)` | Verifies `diagramId` is owned by `ownerEmail` (via `DiagramRepository.findOwned`) and `collaboratorEmail` exists in `users`; rejects the owner adding themselves; idempotent — adding an already-added collaborator returns the existing row rather than erroring, so the client never has to special-case "already a collaborator." |
| `CollaboratorRepository.remove(diagramId, actorEmail, collaboratorEmail)` | Removes one row. Allowed for the diagram's owner (removing anyone) **or** for `actorEmail === collaboratorEmail` (a collaborator removing themselves — "Leave diagram"). Every other combination is rejected before touching D1. |
| `CollaboratorRepository.list(diagramId)` | Every collaborator row for a diagram, joined against `users` for `displayName` (currently always `null` in this demo — see `docs/09-ARCHITECT.md`'s `users` table note — kept for schema fidelity and forward compatibility, not because it is populated yet). |
| `CollaboratorRepository.isCollaborator(diagramId, email)` | Used by `DiagramRepository.findAccessible()` below. |

`DiagramRepository` (`src/worker/diagrams/repository.ts`) gains one new method rather than
changing any existing one:

```ts
/**
 * Load a diagram this identity may read or edit -- either because it owns it, or because it has
 * been granted collaborator access (see `../collaborators/repository.ts`). Returns the diagram
 * plus the caller's `role` ("owner" | "editor") so route handlers can gate owner-only actions
 * (rename, delete, manage collaborators, manage the anonymous share link) without a second query.
 */
async findAccessible(
  id: string,
  email: string,
): Promise<{ diagram: Diagram; role: "owner" | "editor" } | null>
```

`findOwned` itself is **not removed or changed** — every genuinely owner-only route (rename,
delete, create/revoke the anonymous share link, add/remove collaborators) keeps calling it
unchanged, exactly as 9 and 9B already wrote it. Only the routes a collaborator must also be able
to use switch to `findAccessible`: `GET /api/diagrams/:id`, `PUT /api/diagrams/:id/graph` (see
[Live-Editing Architecture](#live-editing-architecture) for why this route's *implementation*
also changes), and `GET /api/diagrams/:id/live`'s pre-upgrade ownership check (9B).

### API

All new routes below live in `diagramsRouter` (`src/worker/routes/diagrams.ts`), already mounted
under `/api/diagrams` — no new sub-router, no new Access destination:

| Route | Authorization | Behavior |
| --- | --- | --- |
| `GET /api/diagrams/:id/collaborators` | Owner or any existing collaborator (`findAccessible`) | List, so a co-editor can see who else has access, not only the owner. |
| `POST /api/diagrams/:id/collaborators` | Owner only (`findOwned`) | Body `{ email }`. `404` if `email` has never signed in (matches the rest of this app's information-disclosure posture: the client-visible error is "that person needs to sign in to Architect at least once first," not a leak of whether the email exists anywhere else). `400` if `email` is the diagram's own owner. |
| `DELETE /api/diagrams/:id/collaborators/:email` | Owner, or the named collaborator removing themselves | `204` either way; `404` if the row does not exist. |
| `GET /api/diagrams/shared-with-me` | Any authenticated identity | Diagrams where the caller is a collaborator (not owner), each annotated with `ownerEmail` so the dashboard can render "Shared by \<owner\>." Deliberately a separate endpoint rather than a `?scope=` query param on the existing `GET /api/diagrams` — that route's existing, unchanged contract ("the signed-in identity's own diagrams") is exactly what 9B's `list_diagrams` MCP tool already documents and relies on; changing its shape would be a breaking change to 9B for no benefit here. |

`diagram_created`/`diagram_updated`-style structured logs gain two new event names,
`collaborator_added` and `collaborator_removed` (diagram id and the affected email only — never
graph content), matching 9's existing logging conventions.

### Client

- `DashboardView.tsx` gains a second section, "Shared with me," populated from
  `GET /api/diagrams/shared-with-me`, rendered with `DiagramGrid.tsx`'s existing card component
  (a small `ownerEmail` badge added to the card for this section only) — no new grid component.
- A new `CollaboratorsModal.tsx`, opened from a new toolbar control distinct from the existing
  `ShareModal.tsx` (9's anonymous read-only link) — keeping "share a read-only link with anyone"
  and "give a specific person edit access" as two visibly different actions matches them already
  being two different concepts server-side. Lists current collaborators with a remove control
  (owner only, or a "Leave" button when the viewer is a collaborator rather than the owner), and
  an add-by-email form surfacing the `404`/`400` cases above as plain inline validation messages.

## Live-Editing Architecture

### Why Not A CRDT

Two authenticated humans editing the same diagram sounds, at first, like it needs the same
machinery a real-time collaborative text editor does (Yjs, Automerge, operational transform). It
does not, for one structural reason: this diagram's edit surface is a **discrete set of
identifiable objects** (nodes and edges, each with a stable UUID) rather than a linear character
stream, and 9B already built the exact right vocabulary for mutating that set —
`addNode`/`updateNode`/`removeNode`/`addEdge`/`updateEdge`/`removeEdge`
(`src/worker/diagrams/graph-mutations.ts`). At that granularity, "two operations landed in some
order and the second one wins" is a completely adequate conflict policy — the same one a
shared spreadsheet or shared to-do list uses at the cell/row level — and a Durable Object's single
active instance per diagram id, combined with a small amount of ordinary in-process serialization
code (see [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)), gives that ordering
guarantee without a distributed data structure. Reaching for a CRDT here would be solving a
problem this demo does not have, at real cost to `docs/BACKLOG.md`'s own stated teaching goal (the
Durable Object and WebSocket lesson, not a distributed-data-structures lesson). Keeping the fields
inside a single node/edge as atomic, whole-field replacements (see [Non-Goals](#non-goals)) is
precisely what keeps this true — the moment a field's *contents* needed merging
character-by-character, this reasoning would no longer hold.

### Why D1 Stays The Only Copy

An earlier draft of this section gave `DiagramSession` its own SQLite-backed copy of the graph
(`ctx.storage.sql`), authoritative while a session was live and periodically flushed to D1. That
design was rejected before implementation: it would have meant a diagram's graph exists in two
independently-persisted places at once, and the two can disagree in a way nothing else in this
demo has to think about — for example, restoring D1 from a backup while a `DiagramSession` for
that diagram happens to be resident would silently be undone the moment that object's next flush
landed, since the object has no way to know a restore happened underneath it. That is real,
avoidable complexity for a demo whose point is Durable Objects and WebSockets, not
storage-consistency engineering, and this repository's baseline already prefers the simplest
design that teaches the intended lesson. **D1 keeps its existing role as the diagram's one and
only durable copy, unconditionally — during a live session exactly as much as at any other
time.** `DiagramSession` never calls `ctx.storage.sql`, never gets its own schema, and its
`new_sqlite_classes` migration (already provisioned by 9B, required by Wrangler for any Durable
Object class regardless) continues to back nothing meaningful, exactly as 9B's own text already
says.

What `DiagramSession` gains instead is a small amount of **in-process, disposable** state and
coordination — nothing durable, nothing that a backup/restore story needs to account for:

- **An in-memory working copy**, a plain class field (`this.graph: GraphData`), hydrated once
  from D1 the first time the object is asked to do anything after a cold start or an eviction —
  guarded by `blockConcurrencyWhile()` (the correct tool for one-time initialization per the
  `durable-objects` skill) so no operation is ever applied against a not-yet-hydrated graph. This
  field exists purely so an operation doesn't need its own D1 read before it can be applied — it
  is an ordinary read-through cache, not a second source of truth. Losing it to hibernation costs
  nothing but one extra D1 read on the next operation, because nothing is ever persisted *only*
  here (see the next point).
- **A single per-object write chain** (`this.writeChain`, an ordinary chained `Promise`) that
  every persist-to-D1 call joins: `this.writeChain = this.writeChain.then(() => saveGraphData(...))`.
  Each link reads `this.graph` **at the moment it actually runs**, not a value captured when it
  was enqueued, so even though the chain guarantees D1 writes land in the same order they were
  requested, every write also always sends whatever the truly latest in-memory graph is by the
  time its turn comes up. That combination — strict ordering, plus always-fresh reads — is what
  prevents an older, slower write from ever clobbering a newer one in D1, without needing any
  platform-level storage guarantee at all.

Applying one operation, end to end, is:

1. Mutate `this.graph` synchronously (call the matching `graph-mutations.ts` function; no `await`
   anywhere in this step) — this alone is what makes concurrent operations safe: with no `await`
   between reading `this.graph` and replacing it, no other incoming message can possibly
   interleave in the middle, by ordinary single-threaded JavaScript semantics, independent of any
   Durable-Object-specific platform behavior.
2. Broadcast `operation_applied` to every connected client immediately — this is what keeps live
   editing feeling instant; it does not wait on step 3.
3. `await` this operation's turn in `this.writeChain` to persist the (by-now-current) `this.graph`
   to D1 via the **same** `DiagramRepository.saveGraphData()` 9 and 9B already use. The enclosing
   WebSocket message handler or RPC method does not return until this resolves — that is
   deliberate: it keeps the object "busy," from the runtime's own bookkeeping, for exactly as long
   as an unpersisted change exists, which is the simplest way to avoid the object being torn down
   with an applied-but-unwritten operation still only in memory. No `ctx.waitUntil()` and no
   `ctx.storage.setAlarm()` are needed for this.

Because the client already debounces before sending an operation (reusing the editor's existing
`AUTOSAVE_DEBOUNCE_MS` interval — see [Retiring The Whole-Graph
Autosave](#retiring-the-whole-graph-autosave-as-the-primary-write-path)), `DiagramSession` never
sees more than a couple of operations per second even during a continuous drag, so a D1 write per
operation is unremarkable — no batching, debouncing, or second storage layer is needed to keep
that affordable. `saveGraphData()` scopes its `WHERE` clause by the diagram's **owner** email
(unchanged from 9), not the acting editor's — `this.graph`'s hydration already reads the full
diagram row, so the object always has the owner's email on hand regardless of which collaborator
actually triggered a given operation.

One direct, useful consequence of keeping D1 as the only copy: **every existing backup, restore,
and redundancy story for a diagram's graph is completely unaffected by this document.** D1's own
point-in-time recovery is still the one and only mechanism an operator needs to reason about, with
no second, independently-recoverable copy to reconcile against it, and no new failure mode where
a restore is silently undone by a Durable Object that does not know it happened.

### Message Protocol

The existing `GET /api/diagrams/:id/live` WebSocket route (9B) is unchanged in how it is reached
(owner-or-collaborator-checked via `findAccessible` **before** the Worker forwards the upgrade to
the Durable Object, exactly like 9B's existing owner check) but the messages it carries expand
substantially, superseding 9B's single `graph_updated` push:

**Client → `DiagramSession`:**

| Type | Payload | Behavior |
| --- | --- | --- |
| `operation` | `{ clientOpId, op: { kind: "add_node" \| "update_node" \| ..., ...fields } }` | One `graph-mutations.ts` function call, applied against the object's in-memory `this.graph` (see above), then broadcast. |
| `cursor_moved` | `{ x, y }` (canvas coordinates) | Relayed to every other connection, never persisted. Client-throttled (~15/sec) before sending. |
| `selection_changed` | `{ nodeId \| edgeId \| null }` | Relayed as a light "who's looking at what" presence signal — advisory only, see [Non-Goals](#non-goals). |

**`DiagramSession` → client:**

| Type | Payload | Behavior |
| --- | --- | --- |
| `graph_snapshot` | `{ graphData, sequence }` | Sent once, immediately on connect, from the object's own in-memory `this.graph` (hydrated from D1 if this is the first activity since a cold start) — replaces relying on the `GET /api/diagrams/:id` REST response (which may already be stale by the time the socket finishes connecting) as the client's starting state. |
| `presence_snapshot` | `{ participants: [{ email, displayName, color }] }` | Sent once, immediately on connect, alongside `graph_snapshot` — mirrors `demos/chat`'s `ChatRoom` history-replay-on-connect precedent so a newly joined tab is never blind to who is already present. |
| `operation_applied` | `{ clientOpId, actorEmail, origin: "human" \| "agent", op, sequence }` | Broadcast to **every** connection, including the originator (an echo/ack the originating client uses to reconcile `clientOpId` against its own optimistic local state, exactly the pattern any client applying its own change immediately and confirming later needs). `origin` distinguishes a human's own edit from one 9B's MCP tools made *on that same diagram* — see [Interplay With Demo 9B](#interplay-with-demo-9b) — so the client's "Updated by…" toast can say "your agent" instead of a confusing self-attributed edit. |
| `operation_rejected` | `{ clientOpId, reason }` | Sent only to the originating connection when an operation targets a node/edge another operation already removed in the meantime — see [Concurrency Model](#concurrency-model). Never disconnects the socket. |
| `presence_joined` / `presence_left` | `{ email, displayName, color }` / `{ email }` | Broadcast to every other connection as sockets open/close. |
| `cursor_moved` / `selection_changed` | Relayed verbatim with `email` added | Never persisted; dropped entirely if the sending client's own operation channel is backpressured, rather than queued — a missed cursor frame is invisible, a missed graph operation is not. |

Each connecting identity is assigned a stable-for-the-session display color from a small fixed
palette (index chosen by a simple hash of the email), reused for that identity's presence avatar,
cursor, and selection highlight — no new dependency, no persisted color preference.

`sequence` is an ordinary in-memory counter (`this.sequence`, incremented once per applied
operation), used only so a client can order the messages it receives within one connection's
lifetime — it is not persisted and resets to `0` whenever the object rehydrates from D1, which is
harmless: nothing compares a `sequence` value against a previous session's, since a fresh
`graph_snapshot` (not a replayed operation log) is what a reconnecting client always starts from —
see [Concurrency Model](#concurrency-model).

### RPC Surface

`DiagramSession` exposes three RPC methods (replacing 9B's single `notifyGraphUpdated`, whose only
caller — the Worker, after an MCP tool call wrote straight to D1 — no longer exists once
[Interplay With Demo 9B](#interplay-with-demo-9b) below takes effect):

- `applyOperation(op, actorEmail, origin, clientOpId?)` — the one code path every graph mutation
  goes through, whether it originated from a human's WebSocket message or from a 9B MCP tool
  call. Applies the matching `graph-mutations.ts` function against `this.graph`, persists via the
  write chain, and broadcasts `operation_applied` (or, on a stale-target error,
  `operation_rejected` to the originator only) — see [Why D1 Stays The Only
  Copy](#why-d1-stays-the-only-copy) for the full sequence.
- `applyWholeGraphReplace(graphData, actorEmail, origin)` — for the one remaining case a
  whole-graph replace is the more natural shape than N granular operations: 9B's
  `auto_layout_diagram` tool (which legitimately repositions every node at once) and the
  `PUT /api/diagrams/:id/graph` REST route's fallback role, below.
- `getSnapshot()` — used by the WebSocket connect handler to build `graph_snapshot`.

### Retiring The Whole-Graph Autosave As The Primary Write Path

9's `PUT /api/diagrams/:id/graph` route is **not deleted** — it stays as a resilience fallback for
a client that has not yet finished (re)connecting its live WebSocket (for example, the brief
window right after a page load, or after a dropped connection while automatic WebSocket
reconnection is still in progress) — but its handler body changes from writing to D1 directly to
calling `DiagramSession.applyWholeGraphReplace()` on the same object every live connection already
talks to. This is the change that closes the gap 9B's own Post-MVP note left open ("there is no
read-modify-write race across two different owners because every write is scoped to one owner
already" stops being true the moment two different *editors* of the same owner's diagram can write
concurrently) — after this change, **every** write to a diagram's graph, regardless of which route
or channel it arrived through, passes through the one object whose in-memory mutation-then-write
sequence (see [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)) makes concurrent writes
safe. There is never a second writer that can race `DiagramSession`'s own serialized application
of operations, and D1 itself never gains a second writer either — every write still lands through
the same `saveGraphData()` call 9 and 9B already use.

### Interplay With Demo 9B

9B's Phase 13 MCP tool handlers (`add_node`, `update_node`, `remove_node`, `add_edge`,
`update_edge`, `remove_edge`, `auto_layout_diagram`) currently call
`findOwned()` → mutate → `saveGraphData()` → `DiagramSession.notifyGraphUpdated()` directly against
D1, with the Durable Object only ever *notified* after the fact. Once this document ships, those
same handlers call `applyOperation()`/`applyWholeGraphReplace()` on `DiagramSession` instead —
`origin: "agent"` on every call — unifying the MCP write path and the human write path onto the
single code path described above. This is a small, mechanical change to 9B's existing handlers
(swap which function they call at the end of their existing four-step shape), not a new tool or a
new authorization model — 9B's own ownership/authorization checks
(`findOwned`/`findAccessible` once a diagram has collaborators) still gate every tool call exactly
as before.

One user-visible consequence worth calling out explicitly, since 9B's Access Model is what makes
it possible: because a remote MCP client authenticates as the **same** verified identity as the
human who configured it (9B: "There is no second Access application... anyone who can sign in to
the editor can sign in to the MCP server"), an agent's edit and its owner's own live edits share
one email address. `operation_applied`'s `origin` field (see [Message Protocol](#message-protocol))
exists specifically so the client can still tell them apart in its own UI ("Updated by your
agent" vs. attributing the change to the browser tab's own in-flight optimistic edit) even though
the underlying identity is identical.

### Concurrency Model

- **Two operations targeting different nodes/edges**: no interaction at all; both apply and
  broadcast independently, in whichever order `DiagramSession` happened to receive them.
- **Two operations targeting the *same* node/edge (e.g., both editors drag the same node, or both
  edit the same node's label)**: whichever operation `DiagramSession` applies to `this.graph`
  second simply overwrites the first's result — the same last-applied-wins policy 9B already used
  for whole-graph saves, just narrowed from "the whole graph" to "one node or edge." Both editors
  see the same final state (the second operation's `operation_applied` broadcast reaches both,
  including the one whose own edit was overwritten), plus the existing "Updated by \<name\>" toast
  as a visible signal that something changed under them — this is a documented, deliberate
  trade-off (see [Non-Goals](#non-goals)), not silent data loss: the record of *what value won* is
  always visible and correct, only the *earlier* value is gone, exactly as it already was for 9's
  own single-writer autosave.
- **An operation targeting a node/edge another operation already removed** (for example, editor A
  updates a node the instant after editor B deletes it): `graph-mutations.ts`'s `updateNode()`/
  `updateEdge()` throw `notFound()` today (9B); `applyOperation()` catches that specific error and
  responds with `operation_rejected` to the originating connection only, rather than propagating
  it as an unhandled error that would disconnect the socket. The rejected client simply drops that
  one stale local edit — its own `graph_snapshot`/prior `operation_applied` messages already
  reflect the node no longer existing by the time the rejection arrives, so no separate
  reconciliation step is needed.
- **A client reconnecting after a dropped connection** does not replay a missed-operation queue —
  there is no operation log kept for that purpose. It simply receives a fresh `graph_snapshot`
  (and `presence_snapshot`) on reconnect, exactly like a brand-new connection. This is
  intentionally simpler than operation-log replay, and correct because `graph_snapshot` always
  reflects `this.graph`'s current value, which is never behind what has actually been applied.
- **An operator restores D1 from a backup, or edits a `graph_data` row directly, while a live
  session is open**: because D1 is the only durable copy (see [Why D1 Stays The Only
  Copy](#why-d1-stays-the-only-copy)), this is exactly as safe or unsafe as doing the same thing
  to any other Demo 9 table today — the next operation applied through that diagram's
  `DiagramSession` will simply read whatever is currently in `this.graph` (its own in-memory
  cache, unaffected by an external D1 change) and eventually overwrite the row again on its next
  write, the same "last write wins" behavior already documented above. There is no scenario where
  a `DiagramSession` silently reverts an operator's D1-level change on a timer, because nothing is
  ever flushed except as the direct, immediate result of an operation someone actually performed.

## Infrastructure Changes

None. `infra/access.tf`, `infra/architect.tf`, and `wrangler.jsonc.tpl` are all untouched:

- `DIAGRAM_SESSIONS`'s Durable Object binding and `new_sqlite_classes` migration already exist
  from 9B and stay exactly as unused as 9B's own text already describes — this document
  deliberately does not give `DiagramSession` a schema of its own; see [Why D1 Stays The Only
  Copy](#why-d1-stays-the-only-copy).
- The new `diagram_collaborators` table ships as a plain, Wrangler-run D1 migration
  (`demos/architect/migrations/0003_create_diagram_collaborators.sql`), run through the same
  `db:migrate:local`/`db:migrate:remote` scripts 9 and 9B already established — no Terraform
  involvement, matching the precedent 9's own `0002_create_diagram_shares.sql` already set.
- No new Access application, policy, or destination — see [Access Model](#access-model).
- No new `package.json` dependency. Presence avatars and cursor labels reuse `react-feather` and
  this app's existing CSS custom-property theming; no CRDT/OT library is introduced (see
  [Why Not A CRDT](#why-not-a-crdt)).

## Implementation Plan

Phase numbering continues from `docs/09B-ARCHITECT-MCP.md`'s Phase 15.

### Phase 16 - Spike (tag: `phase-16-collab-spike`)

1. Re-verify, against current Cloudflare documentation, that a Durable Object's in-memory (class
   field) state is discarded on hibernation/eviction and that synchronous JavaScript execution
   (no `await` between two statements) cannot be interleaved by an incoming event — the two
   load-bearing platform behaviors [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)
   depends on. Do not take this document's description of that behavior as settled without
   re-confirming it against the live API reference first, per this repository's standing
   retrieval-over-pre-training rule and 9B's own precedent of re-verifying fast-moving platform
   surfaces before building on them.
2. Prototype the race directly: two simulated WebSocket clients sending conflicting operations
   (both targeting the same node) to one `DiagramSession` instance in a
   `@cloudflare/vitest-pool-workers` integration test, asserting the final D1 row reflects exactly
   one deterministic winner and neither operation is silently dropped. This is the automated proof
   the correctness argument in [Why D1 Stays The Only
   Copy](#why-d1-stays-the-only-copy) actually holds in this runtime, not just in the platform's
   documentation.
3. Confirm a slow D1 write genuinely cannot land after — and clobber — a faster, later-enqueued
   write: construct a test where the first operation's persist artificially takes longer than the
   second's, and assert the write chain still leaves D1 reflecting both operations, not just the
   second one's write racing ahead and the first one's stale read overwriting it afterward.

Record findings — and any correction to the design above — in `docs/DECISIONS.md` before Phase 17
starts.

### Phase 17 - Collaborator Model (tag: `phase-17-collaborators`)

1. Add the `diagram_collaborators` migration and `src/worker/collaborators/` module (repository,
   types, validation).
2. Add `DiagramRepository.findAccessible()`; switch `GET /api/diagrams/:id` and
   `PUT /api/diagrams/:id/graph` to it (leave every owner-only route on `findOwned()` unchanged).
3. Add the collaborator routes (`GET`/`POST`/`DELETE /api/diagrams/:id/collaborators`,
   `GET /api/diagrams/shared-with-me`) to `diagramsRouter`.
4. Client: `CollaboratorsModal.tsx`, the dashboard's "Shared with me" section, and switching
   `GET /api/diagrams/:id/live`'s pre-upgrade check to `findAccessible()`.

**Testing:** a non-owner, non-collaborator identity gets `404` (not `403`) on every diagram route,
matching Demo 9's existing information-disclosure posture; a collaborator can read and edit but
not rename/delete/manage sharing/manage other collaborators; adding a never-signed-in email is
rejected with a clear, safe message; a collaborator can remove themselves.

**Definition of done:** the owner can grant a second, already-known identity edit access to a
diagram, and that identity sees it under "Shared with me."

### Phase 18 - Bidirectional Live Sync (tag: `phase-18-live-ops`)

1. Give `DiagramSession` its in-memory working state (`this.graph`, `this.sequence`,
   `this.writeChain`), hydrated from D1 on first use via `blockConcurrencyWhile()` — no schema, no
   `ctx.storage` calls for the graph at all; see [Why D1 Stays The Only
   Copy](#why-d1-stays-the-only-copy).
2. Implement `applyOperation()`, `applyWholeGraphReplace()`, and `getSnapshot()`, each mutating
   `this.graph` synchronously, broadcasting immediately, then `await`-ing the operation's turn in
   `this.writeChain` to persist via `DiagramRepository.saveGraphData()` before the handler
   returns — the exact sequence [Why D1 Stays The Only Copy](#why-d1-stays-the-only-copy)
   describes.
3. Extend the WebSocket handler with the full [Message Protocol](#message-protocol) (`operation`,
   `graph_snapshot`, `operation_applied`, `operation_rejected`, `presence_snapshot`/`joined`/
   `left`); catch `graph-mutations.ts`'s `notFound()` and turn it into `operation_rejected` instead
   of an unhandled error.
4. Update `PUT /api/diagrams/:id/graph` to call `applyWholeGraphReplace()` instead of
   `saveGraphData()` directly (see
   [Retiring The Whole-Graph Autosave](#retiring-the-whole-graph-autosave-as-the-primary-write-path)).
5. Update 9B's MCP tool handlers to call `applyOperation()`/`applyWholeGraphReplace()` with
   `origin: "agent"` instead of writing to D1 directly (see
   [Interplay With Demo 9B](#interplay-with-demo-9b)); remove the now-unused
   `notifyGraphUpdated()` RPC.
6. Client: `DiagramCanvas`/`diagramStore.ts` send operations over the live socket as edits happen
   (reusing the existing `AUTOSAVE_DEBOUNCE_MS` interval for dispatching, not per-keystroke),
   apply incoming `operation_applied` messages from other identities, reconcile echoed
   `operation_applied` messages carrying its own `clientOpId`, and fall back to the existing
   `PUT`-based autosave only while the socket is not connected.

**Testing:** the Phase 16 race test, generalized across every `graph-mutations.ts` operation kind;
an MCP tool call and a connected human editor both mutating the same diagram in the same test,
asserting both the human's socket and D1 end up consistent; an `operation_rejected` case (stale
target); a hydration test confirming a fresh `DiagramSession` (simulating eviction) correctly
re-reads D1 rather than starting from an empty graph.

**Definition of done:** two simulated WebSocket clients against one diagram each see the other's
`add_node`/`update_node`/`remove_node` operations applied live, and a 9B MCP tool call against the
same diagram is visible to both — the automated proxy for this document's central demo moment.

### Phase 19 - Presence And Cursors (tag: `phase-19-presence`)

1. Server: per-connection color assignment, `presence_joined`/`presence_left`, relayed
   `cursor_moved`/`selection_changed`.
2. Client: a small avatar stack in the editor toolbar (connected identities, colored, initials or
   email), a remote cursor overlay on the `@xyflow/react` canvas (colored dot + email label
   following each other connected identity's last reported position), and a light highlight on a
   node/edge another identity currently has selected.

**Testing:** a connecting client receives an accurate `presence_snapshot`; disconnecting one
client is observed as `presence_left` by the other; cursor/selection messages never touch D1 (a
test asserting no additional `saveGraphData()` call occurs for these message types is a direct,
cheap way to catch an accidental persistence regression here).

**Definition of done:** two browser tabs signed in as two different identities, both viewing the
same diagram, each see the other's live cursor position and current selection.

### Phase 20 - Verification (tag: `phase-20-verification`)

1. Close coverage gaps across all three Vitest projects, including the new `collaborators` module
   and `DiagramSession`'s expanded surface.
2. Run formatting, linting, type checking, coverage, production build, Wrangler
   generation/type checks, `terraform fmt -check`, and `terraform validate` (expected to report no
   plan diff at all, per [Infrastructure Changes](#infrastructure-changes)).
3. Extend `README.md` (the two new `/api/diagrams/*` route groups; no new required Access
   permissions), `DEMO.md` (see [Demo Flow Addition](#demo-flow-addition)), and
   `EXPLAIN-DEMO.md` (why node/edge-level last-write-wins replaces a CRDT here, why D1 stays the
   diagram's only durable copy even during a live session, and the relationship to 9B's
   agent-driven live sync — see [References](#references) for further reading to link).
4. Manual smoke check with two real signed-in identities in two separate browser
   profiles/windows, covering: granting collaborator access, concurrent node/edge edits, presence
   and cursor visibility, a stale-operation rejection (deliberately trigger by deleting a node in
   one tab the instant after editing it in the other), and a 9B MCP tool call arriving while both
   tabs are open.

**Definition of done:** every item in this repository's [Completion
Criteria](../AGENTS.md#completion-criteria) holds for this add-on specifically, and a presenter
can run the full `DEMO.md` script end to end without manual workarounds beyond what is documented.

## Demo Flow Addition

Insert after Demo 9B's own `DEMO.md` addition:

1. As the diagram's owner, open `CollaboratorsModal` on an existing diagram and note that a
   colleague's email cannot yet be added (they have never signed in). Have that colleague open
   `/app` once in a second browser profile/window and sign in, then add their email as a
   collaborator.
2. With the owner's tab still open on the diagram, open the same diagram URL in the colleague's
   window. Point out the presence avatar for the second identity appearing in the owner's toolbar.
3. In the colleague's window, drag a node. Watch it move live in the owner's window, with the
   colleague's cursor visible moving across the canvas the whole time.
4. Both tabs open the same node's properties panel at once; each types a different label. Point
   out the "Updated by \<name\>" toast and that both tabs converge on the same final label — the
   last one applied, not a merge of both.
5. With both tabs still open, run the 9B OpenCode session from the earlier demo section against
   the same diagram again. Point out the toast now reads "Updated by your agent" in the owner's
   tab (via the `origin` field) even though the agent authenticates as the owner's own identity.
6. In the colleague's window, click "Leave diagram" from `CollaboratorsModal` and confirm it
   disappears from their "Shared with me" section, while the owner keeps full access.

## Relevant Skills

- `cloudflare`
- `durable-objects` (single active instance per id, in-memory state and hibernation, RPC methods)
- `testing-durable-objects` (multi-client hibernatable WebSocket integration tests)
- `cloudflare-terraform-best-practices` (confirming this document genuinely introduces no
  Terraform diff)
- `workers-best-practices`
- `wrangler`

## References

### Durable Objects

- [Durable Objects: WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Objects: Rules of Durable Objects (best practices)](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects: in-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)

### This Demo's Prior Documents

- [`docs/09-ARCHITECT.md`](./09-ARCHITECT.md) — the MVP this document extends, and the
  [Post-MVP section](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) this document
  resolves.
- [`docs/09B-ARCHITECT-MCP.md`](./09B-ARCHITECT-MCP.md) — introduces `DiagramSession` and
  `graph-mutations.ts`, both extended (not replaced) here.
- [`docs/BACKLOG.md`](./BACKLOG.md) — the original demo 9 write-up asking for "collaborative
  editing (two authenticated users can edit the same diagram and each user sees the cursor of the
  other user)," and the curriculum principle deferring general "collaborative code editing" this
  document's [Non-Goals](#non-goals) explains why does not block this narrower, node/edge-level
  form of it.
