# Architect — What This Demo Teaches

> This file describes Phases 1–4 (scaffolding/Access, the diagram library/editor, read-only
> sharing, and admin) of `docs/09-ARCHITECT.md`, a Cloudflare architecture diagram editor ported
> from a real, working prior art application (CF-Architect). Later phases add
> export/print/dark-mode capabilities the full plan describes.

## What This Demonstrates

- **A mixed public/authenticated hostname with two Cloudflare Access applications.** One
  hostname-wide `bypass` application covers the public landing page; a second, more specific
  `allow` application scoped to `/app*`, `/api/me`, and `/api/diagrams*` destinations requires
  any authenticated identity. Access evaluates the most specific matching application per
  request, so the two applications never conflict — see [Public Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/) in AGENTS.md for the general pattern this demo follows. Phase 3's anonymous share resolver
  (`/api/share/*`) is deliberately left off the authenticated application's destinations for
  exactly this reason — see "Read-only sharing without ever storing a raw token" below.
- **Digest-only secret storage, not merely "hashed passwords are good practice."** CF-Architect's
  own share-link implementation stores the raw, working token in D1 and uses it directly as a
  Workers KV key — a real plaintext-secret-storage bug in otherwise-working prior art. This port
  fixes it by persisting only a SHA-256 digest of the token everywhere, which produces a genuine,
  visible product tradeoff (not just an invisible storage detail): the server itself can no
  longer answer "what is my diagram's current share link?" after the moment of creation, so the
  owner UI has to be designed around a link that is shown *once* — see "Read-only sharing without
  ever storing a raw token" below.
- **Independent, application-level admin authorization on top of Access.** `cloudflareAccess()`
  alone proves only that *some* valid identity from this Cloudflare Access team authenticated —
  every Access application in a team shares the same JWKS, so a token minted for a *different*
  application in the same team would also be accepted here (cross-application token replay).
  This demo pins the Access application's own audience (`aud`) tag as defense against that, and
  layers a second, independent comparison against an operator-configured `ADMIN_EMAIL` value:
  `GET /api/me` reports `isAdmin` to every identity (for client-side UI conditionals), while
  every `/api/admin/*` route's `requireAdmin` middleware (`src/worker/middleware/admin.ts`)
  independently re-checks the same comparison server-side and rejects everyone else with `403`
  — there is no D1 role column, and exactly one identity is ever the administrator, set by the
  operator rather than by a first-user-wins bootstrap.
- **React as a deliberate, scenario-scoped exception to this repository's Vue default.** This
  port's UI is React because the real prior art (CF-Architect) and the diagram library it needs
  (`@xyflow/react`) are both React; rewriting proven, working functionality in Vue first would be
  pure translation effort with no new teaching value.
- **A lightweight identity directory that is explicitly never an authorization source.** Every
  authenticated request upserts a `users` row keyed on the verified email. The table backs the
  read-only admin user directory (`GET /api/admin/users`) — no route ever reads it to decide what
  a request is allowed to do, which is why `upsertUserMiddleware` performs no authorization check
  of its own, and why the admin route computes each row's diagram count with a live correlated
  subquery against `diagrams` rather than trusting a stored counter.
- **Diagram moderation that reuses the same owner-blind projection as anonymous sharing, rather
  than inventing a second one.** `GET /api/admin/diagrams/:id` calls the exact same
  `DiagramRepository.findPublicFields()` the public share viewer already uses (never selecting
  `ownerEmail`), so the admin UI's "preview before delete" capability can never expose more about
  a diagram than a random person already could by holding any diagram's share link — a
  deliberately narrow reading of docs/09-ARCHITECT.md Phase 4's "diagram moderation (view/delete
  any user's diagram)" that keeps the blanket "a non-owner cannot read another user's diagram"
  test intact for content, while still allowing the one, explicitly-provisioned administrator to
  moderate.
- **A drag-and-drop diagram editor built entirely on raw D1 and a client-side graph library, with
  no ORM.** `@xyflow/react` owns the canvas; a small Zustand store
  (`src/client/stores/diagramStore.ts`) tracks nodes, edges, viewport, selection, and a
  session-scoped undo/redo stack. The Worker never inspects individual node/edge contents beyond
  a shallow shape check (`src/worker/diagrams/validation.ts`'s `validateGraphDataInput()`) — a
  diagram's `graph_data` column is opaque JSON as far as the server is concerned.
- **Same-origin and content-type enforcement as its own composable middleware, not a bundled
  library default.** `enforceSameOriginJson()` (`src/worker/middleware/same-origin.ts`) rejects
  every state-changing `/api/diagrams` request whose `Sec-Fetch-Site`/`Origin` headers do not
  match this Worker's own origin, and whose body is not exactly `application/json` — defense in
  depth on top of Cloudflare Access, since Access alone proves *who* is asking, not that the
  request itself originated from this demo's own browser UI.
- **A static product/blueprint catalog shared between the client and the Worker.**
  `src/catalog.ts` and `src/blueprints.ts` sit outside both `src/worker/` and `src/client/`
  (alongside `src/access-policies.ts`, Phase 1's own precedent for a module both layers import)
  because the palette/canvas render from it in the browser and `POST /api/diagrams` resolves a
  `blueprintId` against it on the server — the same data, never duplicated.

## How It Works

### Data model

`migrations/0001_create_diagrams_and_users.sql` creates the `diagrams` and `users` tables Phase 1
through Phase 4 need; `migrations/0002_create_diagram_shares.sql` adds `diagram_shares` for
Phase 3:

```sql
CREATE TABLE diagrams (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  graph_data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE diagram_shares (
  token_digest TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
```

`diagrams.owner_email` replaces CF-Architect's `owner_id` foreign key into its own `users` table
entirely, since the verified Access identity *is* the owner key — there is no separate internal
user identifier anywhere in this schema. `users.display_name` is always `NULL` today:
`cloudflareAccess()`'s verified identity (`src/worker/bindings.ts`) exposes only `email`, `sub`,
and `source` — no name claim — and this demo provisions no Identity Provider of its own that
could supply one (see "Dropped: a provisioned Identity Provider" below). Wrangler owns this
schema through `db:migrate:local`/`db:migrate:remote`; Terraform owns only the
`cloudflare_d1_database` resource itself. Notably absent from `diagrams`: a `blueprint_id`
column. Once a diagram is cloned from a blueprint template, its graph is fully independent of
that template — `POST /api/diagrams` resolves `blueprintId` against `BLUEPRINT_MAP`
(`src/blueprints.ts`) purely to seed the new row's `graph_data`, and never persists which
blueprint (if any) it came from. `diagram_shares.token_digest` is discussed in its own section
below.

### The diagram editor and its API

`DiagramRepository` (`src/worker/diagrams/repository.ts`) scopes every read and write to
`owner_email` in the same query, mirroring `demos/agentic-ai-chat`'s `ChatRepository` pattern: a
diagram id that exists but belongs to a different identity is indistinguishable from one that
never existed at all, so every route reports `404`, never `403`, for either case. `PUT
/api/diagrams/:id/graph` replaces the *entire* graph on every autosave — there is no partial-patch
protocol — after `validateGraphDataInput()` re-serializes it into a canonical shape (`nodes`,
`edges`, and `viewport` are always present, defaulted if the client omits any of them).

On the client, `DiagramCanvas` (`src/client/components/editor/DiagramCanvas.tsx`) debounces
autosave 500 ms after the last change and a title-only save 1 s after the last keystroke,
independently — a title edit alone does not wait on the (usually much larger) graph payload,
and vice versa. Every mutation to the Zustand store that structurally changes the graph (adding
or removing a node/edge, running ELK auto-layout) pushes an undo snapshot first, so `Ctrl+Z`/
`Ctrl+Shift+Z` and the toolbar's Undo/Redo buttons operate on exactly the same history stack a
keyboard shortcut would.

The service palette (`src/client/components/editor/panels/ServicePalette.tsx`) supports both
drag-and-drop onto the canvas and a click/keyboard-activatable "add at center" path — CF-Architect's
original palette was drag-only, with no keyboard or screen-reader route to add a node at all,
which does not meet this repository's WCAG 2.2 AA bar for a primary workflow.

ELK (`elkjs`), the auto-layout engine, is imported with a dynamic `import()` only when a user
actually clicks a layout button (`src/client/components/editor/toolbar/Toolbar.tsx`), rather than
bundled into the main chunk. This repository's prior Vue attempt at this same demo measured a
~540 KB gzip cost for the equivalent library bundled eagerly; lazy-loading keeps the feature
without paying that cost on every page load.

### Read-only sharing without ever storing a raw token

CF-Architect's own share-link implementation (`src/lib/repository/share-repository.ts` in the
prior art repository) persists the raw token in D1 and uses it directly as a Workers KV key — a
real, working plaintext-secret-storage bug, not a hypothetical one. `ShareRepository`
(`src/worker/shares/repository.ts`) fixes it: every token this Worker ever mints is hashed with
`crypto.subtle.digest("SHA-256", ...)` before it touches either store, and the hex digest — never
the token — is what `diagram_shares.token_digest` and the `SHARES` KV key both actually are.
`resolve()` checks KV first (the fast, common-case path an anonymous viewer's every request
takes) and falls back to a D1 lookup — backfilling KV — only on a miss, which can genuinely
happen briefly after a write due to Workers KV's cross-colo eventual consistency.

This fix has a real, visible product consequence, not just an invisible storage detail: because
the server never keeps the raw token anywhere, `GET /api/diagrams/:id/share` can report *that* a
share is active, but can never again display *what* its URL is. `POST
/api/diagrams/:id/share` is the one and only response that ever carries a working link — and it
doubles as an implicit token-rotation operation, since minting a new one first revokes any share
already active for that diagram (`ShareRepository.rotate()`), so a diagram never has two
simultaneously valid links to reason about. The owner UI (`ShareModal.tsx`) is built around this
constraint directly: reopening the dialog on a diagram with an already-active share shows a
"link is active, but not shown again" message with a **Generate new link** action, rather than
pretending it can fetch the existing URL back.

Sharing is a live pointer, not a snapshot: `GET /api/share/:token` (`src/worker/routes/shares.ts`)
resolves a token to a `diagram_id` and then reads that diagram's *current* `graph_data` on every
request — there is no separate copy to fall out of sync, so an edit the owner makes after sharing
is visible through an already-distributed link on the very next anonymous request. `revoked_at`
is set rather than deleting a `diagram_shares` row on revoke, so the table doubles as a small
audit trail of a diagram's past links; deleting a diagram itself cascades
`ShareRepository.revokeAllForDiagram()` (called from `../routes/diagrams.ts`'s owner-delete
route) so a share for a now-gone diagram can never keep resolving. A malformed, unknown, and
revoked token are all reported as an identical `404` — never a distinguishing status code — so an
anonymous caller can never use the resolver as an oracle for "did this link exist once?"

### The two-application Access model

`infra/access.tf` provisions:

1. A `bypass` policy + application covering the whole hostname (`architect.cfapps.uk`) — the
   public landing page, `/blueprints`, and the read-only share viewer (`/s/:token`) need no
   Access challenge at all.
2. An `allow` policy (`include = [{ everyone = {} }]`, meaning any authenticated identity from a
   configured provider) + application scoped to `/app*`, `/api/me`, and `/api/diagrams*`
   destinations — deliberately narrower than a bare `/api/*` wildcard.

That narrower destination list is what keeps the anonymous share resolver (`/api/share/*`)
public: Access routes each request to the *most specific* matching application, and since
`/api/share/*` is not one of this application's listed destinations, it simply is not covered by
it, and falls through to the hostname-wide `bypass` application instead — the same pattern
`demos/media-drop` uses to carve out a public path from an otherwise-authenticated `/api/*`.
`src/access-policies.ts`'s shared array mirrors this with its own explicit `/api/share`
`authenticate: false` entry, listed *ahead of* the general `/api` entry so `cloudflareAccess()`'s
first-match-wins evaluation reaches it first.

Because Access enforces both at the edge, `/app*` needs no server-side gate of its own — it is
served by the `ASSETS` binding's `single-page-application` fallback exactly like the public
landing page, and `wrangler.jsonc.tpl`'s `run_worker_first` lists only `/api/*`
(`src/worker/index.ts`). `src/access-policies.ts` defines one shared array of path policies
consumed by both `cloudflareAccess()` in the Worker (`src/worker/middleware/access.ts`) and, in
local development, `@adrianhall/cloudflare-toolkit/vite`'s `cloudflareAccessPlugin()`
(`vite.config.ts`) — the same array documents every path's access level in one place, with the
public catch-all deliberately listed last so a newly added protected path can never silently
inherit public access by omission.

`accessMiddleware` pins `audience` to the `/app*`+`/api/diagrams*`+`/api/me` application's own AUD
tag (`infra/access.tf`'s `app` application, exposed as the `access_audience` Terraform output),
threaded in as a Vite build-time define (`VITE_ACCESS_AUDIENCE`) rather than a generated Worker
var — `cloudflareAccess()` reads `audience` once at Worker module-load time, before any
request-scoped `env` binding is available.

### Independent admin authorization

`GET /api/me` (`src/worker/routes/me.ts`) returns `{ email, isAdmin }` for **every** authenticated
identity — unlike `demos/url-shortener`'s admin-only `/api/me`, an ordinary user gets a `200`,
not a `403`. `isAdmin` is computed by one comparison, `identity.email === context.env.ADMIN_EMAIL`
— there is no D1 role column, no first-user-becomes-admin bootstrap, and no promote/demote
workflow. Exactly one identity is ever the administrator, and it is set by the operator through
`.env`/Terraform, not by the application. The client (`src/client/hooks/useIdentity.ts`) uses
`isAdmin` to conditionally render admin UI (`AppShellView`'s **Admin** nav link, and the route to
`AdminView`) without a separate round trip.

`GET /api/me` reporting `isAdmin` to everyone is a UI convenience only, never the actual security
boundary: every route under `/api/admin` independently re-runs the identical `ADMIN_EMAIL`
comparison through `requireAdmin` (`src/worker/middleware/admin.ts`), mounted ahead of every
handler in `src/worker/routes/admin.ts`. A non-administrator who navigates straight to `/app/admin`
(bypassing the hidden nav link entirely) still gets refused — `AppShellView` shows a "not
available" message instead of mounting `AdminView`, and even if it didn't, every request
`AdminView`'s components would make gets `403` from the Worker regardless.

### User directory and diagram moderation (Phase 4)

`GET /api/admin/users` (`src/worker/routes/admin.ts`) lists a page of the `users` directory,
most recently active identity first, each annotated with a live diagram count computed by a
correlated subquery (`UserRepository.listWithDiagramCounts()`) rather than a denormalized counter
column that could drift. `limit`/`offset` query parameters are validated
(`src/worker/users/validation.ts`) and capped at 100 rows per page to bound worst-case D1 read
cost; the client's `UserDirectoryTable` renders this as a paginated table with Previous/Next
controls.

`DELETE /api/admin/diagrams/:id` deletes any user's diagram regardless of owner
(`DiagramRepository.removeAny()`, deliberately unscoped by `owner_email` unlike every other
diagrams-table query in this codebase) and cascades
`ShareRepository.revokeAllForDiagram()` — the same cascade the owner's own delete route already
performs — so a moderated diagram's share link can never keep resolving afterward.

`GET /api/admin/diagrams/:id` is this port's one deliberate, documented extension beyond
docs/09-ARCHITECT.md Phase 4's literal two-route list, added to support that same phase's UI
requirement ("the ability to open ... any user's diagram"): it returns exactly the same
owner-blind projection (`id`, `title`, `description`, `graphData` — never `ownerEmail`) that
`GET /api/share/:token` already exposes to a completely anonymous visitor holding any diagram's
share link. Reusing that existing, already-audited projection is what keeps this route from
becoming a second, broader way to discover who owns a diagram — the actual guarantee
docs/09-ARCHITECT.md's non-negotiable tests care about — while still letting the administrator
see what a diagram actually contains before deciding whether to delete it. The client's
`DiagramModerationPanel` takes a diagram id typed or pasted in by the administrator (found, for
example, via the D1 console's `diagrams` table, exactly as `DEMO.md`'s script does) rather than
picking one from a list, because `GET /api/admin/users` deliberately reports only a diagram
*count* per identity, not the diagrams themselves.

### Dropped: a provisioned Identity Provider

CF-Architect provisions a Terraform-managed GitHub Identity Provider. This port drops that
resource entirely: Access authentication relies on whichever Identity Provider(s) the target
account's Zero Trust team already has configured, exactly like every other demo in this
repository. That is also why `users.display_name` has no data source yet — GitHub's OAuth profile
was the only name source CF-Architect had, and this demo intentionally does not reintroduce a
GitHub-specific dependency to get one back.

### Observability

`cloudflareLogger()` provides request-scoped structured logging on every request.
`problemDetailsErrorHandler()`/`notFoundHandler()` give every error response — including an
unauthenticated `401` from `accessMiddleware` and a `404` for any unmounted API route — the same
RFC 9457 `application/problem+json` shape. Terraform enables Workers Logs at 100% sampling and
traces at 10% sampling on the Worker resource — and `wrangler.jsonc.tpl` carries a literal,
value-for-value copy of that same `observability` block. That duplication is deliberate, not an
oversight: `wrangler deploy` resets a Worker's observability metadata to disabled whenever its
own config omits the block, even when Terraform already turned it on, so mirroring the same
values into `wrangler.jsonc.tpl` is what keeps every deploy from silently disabling logs and
traces again (see `docs/DECISIONS.md` #24/#25 for the live-verified detail and the two fixes
tried).

## Further Reading

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1](https://developers.cloudflare.com/d1/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workers KV](https://developers.cloudflare.com/kv/)
- [Web Crypto API — `SubtleCrypto.digest()`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest) — used to hash every share token before it is ever persisted.
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Manage reusable Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [React](https://react.dev/)
- [React Flow (`@xyflow/react`)](https://reactflow.dev/) — the diagram canvas library.
- [Zustand](https://zustand.docs.pmnd.rs/) — the editor's client-side state store.
- [ELK.js](https://github.com/kieler/elkjs) — the automatic graph layout engine, lazy-loaded on first use.
- [Fetch metadata request headers (`Sec-Fetch-Site`)](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site) — the primary signal `enforceSameOriginJson()` relies on.
- `spikes/06-architect-reactflow-host/REPORT.md` — this repository's Phase 0 spike confirming the plain Vite/React/Cloudflare host architecture.
