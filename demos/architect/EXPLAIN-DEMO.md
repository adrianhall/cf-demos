# Architect — What This Demo Teaches

Architect is a Cloudflare architecture diagram editor: an authenticated user drags Cloudflare
product icons onto a canvas, connects them, and gets an autosaved, shareable, exportable
diagram. This file explains the Cloudflare capabilities it demonstrates and the key design
decisions behind how it works.

This document also covers a follow-on extension, described in full in
`docs/09B-ARCHITECT-MCP.md`: a remote [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server at `POST /mcp` that lets an external agentic harness (OpenCode, or any other
MCP-compliant client) create, edit, share, and export a signed-in user's own diagrams — plus a
small Durable Object that pushes an agent's edits live into any browser editor tab the user
already has open. It adds no new deployable unit, domain, or D1 table; it is the same demo,
extended with an agent-facing surface on top of the application described above.

## What This Demonstrates

- **A mixed public/authenticated hostname with two Cloudflare Access applications.** One
  hostname-wide `bypass` application covers the public landing page; a second, more specific
  `allow` application scoped to `/app*`, `/api/me`, and `/api/diagrams*` destinations requires
  any authenticated identity. Access evaluates the most specific matching application per
  request, so the two applications never conflict. The anonymous share resolver (`/api/share/*`)
  is deliberately left off the authenticated application's destinations for exactly this reason
  — see "Read-only sharing without ever storing a raw token" below.
- **Digest-only secret storage, not merely "hashed passwords are good practice."** A share link's
  token is never persisted anywhere in raw form: it is hashed with SHA-256 before it ever touches
  D1 or Workers KV, and only the digest is stored. That produces a genuine, visible product
  tradeoff (not just an invisible storage detail): the server itself can no longer answer "what
  is my diagram's current share link?" after the moment of creation, so the owner UI has to be
  designed around a link that is shown *once* — see "Read-only sharing without ever storing a raw
  token" below.
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
- **React chosen for library availability, not preference.** The editor's canvas is built on
  React Flow (`@xyflow/react`), the most capable open-source diagramming library available for
  drag-and-drop node/edge editing — a React library. The rest of the client follows from that:
  the UI is React because the canvas library it needs to render into is React.
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
  a diagram than a random person already could by holding any diagram's share link — the
  administrator can moderate content without the moderation route becoming a second, broader way
  to discover who owns a diagram.
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
  because the palette/canvas render from it in the browser and `POST /api/diagrams` resolves a
  `blueprintId` against it on the server — the same data, never duplicated.
- **A generated artifact intentionally built to different conventions than the demo itself.**
  "Export as project" produces a downloadable, ordinary `wrangler.toml`-based starter project
  (`src/client/lib/scaffold.ts`) for whoever downloads it to build on — not code this demo itself
  runs. It uses Drizzle ORM and a plain, hand-editable `wrangler.toml` rather than raw D1 and a
  Terraform-generated config, because the generated project is a teaching artifact aimed at an
  ordinary Wrangler user starting a new project, not a copy of this demo's own infrastructure.
- **A client-side-only feature set needing no Worker or Terraform changes at all.** Export, print,
  and dark mode add no new API route, D1 table, or Cloudflare resource — every line of it lives in
  `src/client/`, exercised by the `client` Vitest project alone.
- **A non-browser OAuth 2.1 client authenticating through the same Cloudflare Access application
  as a browser, via Managed OAuth.** Rather than a second Access application, a separate
  allow-list, or a service-token/machine-identity path, Access's Managed OAuth capability turns
  the *existing* `app` application into a real OAuth 2.1 authorization server: a remote MCP
  client (OpenCode, or any other MCP-compliant harness) completes the same login, against the
  same identity provider, under the same policy, as a person opening `/app`. Anyone who can sign
  in to the editor can sign in to the MCP server, and nobody else can.
- **A remote MCP server reusing its host application's data-access layer in-process, not over a
  second network hop.** Every MCP tool calls the same `DiagramRepository`/`ShareRepository`/
  `generateScaffold()` functions the REST API already uses, as ordinary function calls — there is
  no internal HTTP round trip from the MCP handler back into this Worker's own API, and no
  forked or duplicated data-access code for agent-driven traffic to fall out of sync with.
- **A deliberately narrow, justified Durable Object: coordination for open connections, not a
  second copy of the data.** `DiagramSession` holds no durable state of its own — D1 remains the
  only source of truth for a diagram's graph — it exists purely as a live fan-out point for
  browser WebSocket connections on one diagram, because "push the instant something changes to
  every currently-connected client" is a real persistent-connection coordination problem, the one
  case in this demo that polling (this repository's usual first choice — see `docs/DECISIONS.md`
  and `docs/10-OPENCODE-BROWSER.md`'s own precedent) cannot satisfy well enough to be worth
  choosing anyway.
- **A read-only, single-owner live-sync channel, deliberately not real-time multi-user
  collaboration.** `DiagramSession` never accepts writes from the browser side of its socket, and
  conflict resolution is plain last-write-wins — sufficient because the only two writers are one
  owner's browser tab and that same owner's own agent, never two different people. Real
  concurrent-editor collaboration remains its own, separately-scoped future work (see "Live sync
  and concurrency" below).

## How It Works

### Data model

`migrations/0001_create_diagrams_and_users.sql` creates the `diagrams` and `users` tables;
`migrations/0002_create_diagram_shares.sql` adds `diagram_shares`:

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

`diagrams.owner_email` is the diagram's only owner reference — the verified Access identity *is*
the owner key, so there is no separate internal user identifier anywhere in this schema.
`users.display_name` is always `NULL` today: `cloudflareAccess()`'s verified identity
(`src/worker/bindings.ts`) exposes only `email`, `sub`, and `source` — no name claim — and this
demo relies on whichever Identity Provider(s) the account's Access team already has configured
rather than provisioning one of its own that could supply a name (see "No provisioned Identity
Provider" below). Wrangler owns this schema through `db:migrate:local`/`db:migrate:remote`;
Terraform owns only the `cloudflare_d1_database` resource itself. Notably absent from `diagrams`:
a `blueprint_id` column. Once a diagram is cloned from a blueprint template, its graph is fully
independent of that template — `POST /api/diagrams` resolves `blueprintId` against
`BLUEPRINT_MAP` (`src/blueprints.ts`) purely to seed the new row's `graph_data`, and never
persists which blueprint (if any) it came from. `diagram_shares.token_digest` is discussed in its
own section below.

### The diagram editor and its API

`DiagramRepository` (`src/worker/diagrams/repository.ts`) scopes every read and write to
`owner_email` in the same query: a diagram id that exists but belongs to a different identity is
indistinguishable from one that never existed at all, so every route reports `404`, never `403`,
for either case. `PUT
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
drag-and-drop onto the canvas and a click/keyboard-activatable "add at center" path, so adding a
node to the diagram has a keyboard- and screen-reader-operable route, not only a mouse-drag one.
The palette's category expand/collapse state also persists per user across sessions
(`src/client/lib/palette-preferences.ts`, `localStorage`-backed like the dark mode preference),
seeded to Compute expanded and every other category collapsed on a first-ever visit, rather than
resetting to fully expanded on every editor open.

Connecting two nodes has the same two-route design as creating one, closing the other half of
the same accessibility story: `@xyflow/react`'s only built-in connection mechanism is dragging
between two canvas `Handle`s (or, at best, clicking one unfocusable handle then another — see
`docs/DECISIONS.md` #28 for why that still fails for a keyboard user), which has no keyboard or
switch-access equivalent at all (WCAG 2.2 SC 2.5.7 / 2.1.1). The toolbar's "Connect nodes" button
opens `ConnectNodesModal.tsx`: pick a source, a target, and a connection type from three native
`<select>`s, each already keyboard-operable by construction. A small pure module,
`src/client/components/editor/connect.ts`, resolves which of the two nodes' catalog handles the
new edge should use and validates the pair (no self-connections, no exact source/target/edge-type
duplicates) before `diagramStore.ts`'s `connectNodes` action actually creates it — the same
store-level primitive the properties panel and export code already read from, so a
dialog-created edge is indistinguishable from a drag-created one everywhere else in the app.

ELK (`elkjs`), the auto-layout engine, is imported with a dynamic `import()` only when a user
actually clicks a layout button (`src/client/components/editor/toolbar/Toolbar.tsx`), rather than
bundled into the main chunk — bundling it eagerly adds roughly 540 KB gzip to the initial page
load for a feature many users never use, so lazy-loading keeps the feature without paying that
cost up front.

The editor has its own single toolbar, not a stacked app-shell header: `AppShellView.tsx` renders
the shared `AppHeader.tsx` banner only for the dashboard and admin sub-views
(`route.view !== "editor"`), never for the editor itself. Reaching the editor always means having
come from a header-bearing view first (the dashboard, or a share link with no header at all), and
`Toolbar.tsx`'s own back-arrow button returns there, where the header — and sign-out — is
available again; stacking a second, mostly-redundant banner above a toolbar that already has a
way back added visual noise without adding a capability.

`DiagramCanvas.tsx` also fits the freshly loaded diagram into view exactly once per mount, via
`useNodesInitialized()` rather than `<ReactFlow>`'s own mount-time `fitView` prop: `CFNode.tsx`'s
custom node renderer has no explicit `width`/`height`, so its real rendered size isn't known
until slightly after that first mount, and the prop's fit (computed synchronously at mount,
against effectively unmeasured nodes) could compute a viewport that left the diagram's real,
later-measured nodes scrolled outside the frame — most visibly for a diagram just created from a
multi-node blueprint. `useNodesInitialized()` flips to `true` only once every node has a real
measured size, so fitting then, exactly once, reliably frames what the user actually sees without
fighting their own subsequent pan/zoom. This alone was not enough, though: `.app-shell` sets only
`min-height: 100vh`, and flexbox `flex-grow` doesn't redistribute space within a container whose
main size isn't definite, so `.app-shell__main--editor`'s `flex: 1 1 auto` never actually filled
the viewport — `<ReactFlow>`'s own `height: 100%` wrapper fell back to sizing from its (already
mis-fitted) content instead, feeding back into the very `fitView` calculation meant to fix it. A
real headless-browser repro (Chromium via Playwright — the mocked `@xyflow/react` this
repository's own Vitest suite uses can't exercise real layout) is what surfaced this, since it
requires actual layout/measurement, not just component logic. Giving
`.app-shell__main--editor` a real `height: 100vh` — safe specifically because Bug 23 already
removed the header that used to share that space — fixed it for good, matching the identical
pattern `.share-view` (the anonymous viewer's own full-viewport container) already used.

### Read-only sharing without ever storing a raw token

`ShareRepository` (`src/worker/shares/repository.ts`) never stores a share token in raw form:
every token this Worker mints is hashed with `crypto.subtle.digest("SHA-256", ...)` before it
touches either store, and the hex digest — never the token — is what `diagram_shares.token_digest`
and the `SHARES` KV key both actually are. This means a database or KV read alone can never leak a
working share link, only knowledge that *some* share is active. `resolve()` checks KV first (the
fast, common-case path an anonymous viewer's every request takes) and falls back to a D1 lookup —
backfilling KV — only on a miss, which can genuinely happen briefly after a write due to Workers
KV's cross-colo eventual consistency.

This has a real, visible product consequence, not just an invisible storage detail: because
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
it, and falls through to the hostname-wide `bypass` application instead.
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
identity — an ordinary user gets a `200`, not a `403`, so the client can read its own identity
and admin status in the same call. `isAdmin` is computed by one comparison,
`identity.email === context.env.ADMIN_EMAIL` — there is no D1 role column, no
first-user-becomes-admin bootstrap, and no promote/demote workflow. Exactly one identity is ever
the administrator, and it is set by the operator through `.env`/Terraform, not by the
application. The client (`src/client/hooks/useIdentity.ts`) uses `isAdmin` to conditionally
render admin UI (`AppShellView`'s **Admin** nav link, and the route to `AdminView`) without a
separate round trip.

`GET /api/me` reporting `isAdmin` to everyone is a UI convenience only, never the actual security
boundary: every route under `/api/admin` independently re-runs the identical `ADMIN_EMAIL`
comparison through `requireAdmin` (`src/worker/middleware/admin.ts`), mounted ahead of every
handler in `src/worker/routes/admin.ts`. A non-administrator who navigates straight to `/app/admin`
(bypassing the hidden nav link entirely) still gets refused — `AppShellView` shows a "not
available" message instead of mounting `AdminView`, and even if it didn't, every request
`AdminView`'s components would make gets `403` from the Worker regardless.

### User directory and diagram moderation

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

`GET /api/admin/diagrams/:id` lets the administrator preview a diagram's contents before deciding
whether to delete it, without becoming a second, broader way to discover who owns a diagram: it
returns exactly the same owner-blind projection (`id`, `title`, `description`, `graphData` —
never `ownerEmail`) that `GET /api/share/:token` already exposes to a completely anonymous
visitor holding any diagram's share link. Reusing that existing projection, rather than adding a
second one, is what keeps the guarantee that a non-owner can never read another user's diagram
content intact even for the administrator's moderation view. The client's
`DiagramModerationPanel` takes a diagram id typed or pasted in by the administrator (found, for
example, via the D1 console's `diagrams` table, exactly as `DEMO.md`'s script does) rather than
picking one from a list, because `GET /api/admin/users` deliberately reports only a diagram
*count* per identity, not the diagrams themselves.

### No provisioned Identity Provider

Terraform provisions no Identity Provider resource for this demo: Access authentication relies on
whichever Identity Provider(s) the target account's Zero Trust team already has configured. That
keeps the demo deployable against any account's existing identity setup instead of depending on a
specific provider (GitHub, Google, and so on) being available. It is also why
`users.display_name` has no data source today — an Identity Provider's OAuth profile would be the
natural source for a display name, and this demo intentionally does not add a
provider-specific dependency just to populate one.

### Export, print, and dark mode

`src/client/components/editor/toolbar/ExportButton.tsx` offers three export formats, all
client-side, needing no Worker route: PNG and SVG rasterize the React Flow viewport element
directly with `html-to-image`, computing a bounding box and matching zoom/pan transform from the
current node positions (`getNodesBounds()`/`getViewportForBounds()`) so the exported image matches
a fitted view regardless of the canvas's current on-screen pan/zoom. "Export as project" instead
calls `src/client/lib/scaffold.ts`'s `generateScaffold()`, which walks the diagram's nodes for a
catalog `wranglerBinding` (`src/catalog.ts`) and produces an ordinary, downloadable
`wrangler.toml`-based starter project — a `package.json`, `tsconfig.json`, a `src/index.ts`
matching whichever Worker node type is present (plain, Hono, or Astro SSR), and, if a D1 node is
present, a Drizzle schema/client/migration. `fflate`'s `zipSync()` packages the generated files
into a ZIP entirely in the browser; disabled (with an explanatory `title`) when the diagram has no
node with a catalog `wranglerBinding` at all, since there would be nothing to scaffold. Export,
print, and the dark mode toggle below are rendered unconditionally in `Toolbar.tsx`, including in
read-only mode — an anonymous share viewer (`../../views/ShareView.tsx`) can export or print a
diagram it cannot edit, since neither action can change the diagram (only the Share button itself
stays owner-only).

The canvas minimap (`DiagramCanvas.tsx`'s `<MiniMap>`) can be hidden and shown again through a
map-icon toggle in `Toolbar.tsx`, next to the existing service-palette/properties-panel sidebar
toggles (Bug 4) — a purely session-scoped view preference (`diagramStore.ts`'s `minimapOpen`,
defaulting to visible) rather than a saved graph or `localStorage` setting, since it affects
nothing about the diagram itself.

Print mode (`PrintButton.tsx`, `DiagramCanvas.tsx`'s print-mode effect) hides every editing
affordance (toolbar, palette, properties panel, minimap, controls), shows a title/description
overlay instead, forces a light color scheme for the duration, injects a `<style>` tag choosing a
landscape or portrait `@page` orientation from the diagram's own aspect ratio, fits the view, and
calls `window.print()` — reverting every one of those overrides automatically on the browser's
`afterprint` event (or immediately via the mode's own "← Back" control) so print mode is never a
state a user can get stuck in.

Dark mode (`src/client/lib/theme.ts`, `src/client/components/DarkModeToggle.tsx`) works with the
CSS `light-dark()` function that already themes every surface in `src/client/app.css`, driven by
the `color-scheme` property (`:root { color-scheme: light dark; }`, following the OS preference
by default): toggling the mode means setting an explicit `color-scheme` value on `<html>`, rather
than maintaining a second, hand-written set of dark-mode variable overrides behind a class toggle.
The preference persists in `localStorage`, applied once in `main.tsx` before the first render —
there is no server-rendered markup for an inline `<head>` script to prevent a flash for, since
this is a client-only SPA. The shared `src/client/components/AppHeader.tsx` renders one
`DarkModeToggle` instance, so `AppShellView`'s use of it covers the dashboard and admin views and
`BlueprintsView`'s use of it covers the public blueprint gallery; the editor `Toolbar` renders its
own separate instance for the one page neither covers -- the editor's own header was removed
entirely (see the "Editor has its own single toolbar, not a stacked app-shell header" note
below).

ELK remains the only heavy, lazy-loaded dependency in this editor; `html-to-image` and `fflate`
are small enough (roughly 15 KB and 8 KB gzip respectively) to import eagerly in
`ExportButton.tsx` without meaningfully affecting the initial load.

### The remote MCP server

`src/worker/mcp/server.ts`'s `createServer()` builds a fresh `McpServer` (`@modelcontextprotocol/server`,
via `agents/mcp/server`'s `createMcpHandler`) for every `/mcp` request, closing over that
request's already-verified Cloudflare Access identity. This is deliberate, not an
under-optimization: `createMcpHandler`'s only mechanisms for carrying per-request identity into
its handler are a static `authContext` fixed at handler-creation time, or `ExecutionContext.props`
(a `@cloudflare/workers-oauth-provider` convention this Access-native demo does not use) — a
module-scope singleton handler would freeze the *first* caller's identity into every later request
that reuses it, a real cross-tenant leak for a demo whose entire teaching moment is a live,
multi-actor edit. `agents/mcp/server` also requires the `nodejs_compat` compatibility flag
(`wrangler.jsonc.tpl`): it imports `node:async_hooks`'s `AsyncLocalStorage` at module scope for its
own internal request tracking.

Every tool in `src/worker/mcp/tools.ts` is a thin wrapper over the *exact same*
`DiagramRepository`/`ShareRepository`/`generateScaffold()` functions `src/worker/routes/diagrams.ts`
and `src/worker/routes/shares.ts` already call — in-process function calls, never a second HTTP
round trip back into this Worker's own REST API — so an MCP-driven mutation and a browser-driven
one are indistinguishable to D1 beyond the structured log's own `via: "api" | "mcp"` field
(`context.logger.info(...)`, threaded through every mutating tool and route handler). A tool that
throws a `ProblemDetailsError` (a `notFound()` for a missing or not-owned diagram id, matching
every REST route's behavior) needs no explicit try/catch of its own: the MCP SDK's `tools/call`
handler already converts a thrown error's `.message` into `{ content: [...], isError: true }`
automatically.

Every graph-mutating tool (`add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`,
`remove_edge`, `auto_layout_diagram`) funnels through one shared shape:
`DiagramRepository.findOwned()` an owned diagram, apply one pure function from
`src/worker/diagrams/graph-mutations.ts` to its parsed graph, re-canonicalize with the same
`validateGraphDataInput()`-equivalent helper `src/worker/diagrams/validation.ts` already exposes
to the REST `PUT .../graph` route, `saveGraphData()`, then push the fresh graph to any open editor
tab (see "Live sync and concurrency" below). `graph-mutations.ts`'s functions are pure and unit-
tested against fixture `GraphData` values with no D1, Worker, or MCP involvement at all —
`removeNode()` cascades removal of every edge referencing the removed node (an orphaned edge is a
worse failure mode than an over-eager cascade), and `addEdge()` validates both endpoints exist
before creating anything.

`auto_layout_diagram` does **not** reuse the editor's own ELK-based layout: a real
`@cloudflare/vitest-pool-workers` spike (`spikes/07-architect-mcp-spike/`, `docs/DECISIONS.md` #29)
found `elkjs`'s bundled entry point throws immediately inside `workerd` — its "bundled" file is
actually a Node-targeted browserify bundle whose internal `require()` of a co-bundled worker file
resolves to nothing usable once re-bundled a second time for `workerd`, with or without
`nodejs_compat`. `graph-mutations.ts`'s `autoLayout()` instead implements a deterministic
grid-placement fallback (fixed-spacing rows/columns, breadth-first-ordered from the graph's
edges) — visibly simpler than the editor's own **Layout ↓** toolbar button, which the tool's own
MCP description says plainly, so a calling model does not over-promise the result to a user.

### Authenticating a non-browser client: Cloudflare Access Managed OAuth

`infra/access.tf`'s existing `app` Access application (the same one gating `/app*`, `/api/me`,
`/api/diagrams*`, and `/api/admin*`) gains a fourth destination, `/mcp*`, and an
`oauth_configuration` block turning Access itself into the OAuth 2.1 authorization server a
non-browser MCP client needs — without it, a client that cannot complete a browser login redirect
gets an un-completable `302`. This is deliberately **not** a second Access application, a separate
allow-list, a service token, or a new Identity Provider: the same `authenticated_users` policy
(`decision = "allow"`, any identity from an already-configured provider) still governs `/mcp*`, so
whoever can sign in to the editor can sign in to the MCP server, and no one else can. Managed OAuth
resolves a client's opaque bearer token into the same `Cf-Access-Jwt-Assertion` header
server-side, before the request ever reaches the Worker — `cloudflareAccess()` (mounted on `/mcp`
in `src/worker/index.ts`, via the shared `src/access-policies.ts` array with `authenticate: true,
redirect: false`, matching `/api`'s reasoning that an MCP client is never a browser navigation)
cannot tell, and does not need to tell, whether a request arrived via a browser cookie or via
Managed OAuth.

`oauth_configuration.dynamic_client_registration` is enabled with both
`allow_any_on_loopback`/`allow_any_on_localhost` set — confirmed against a real client
(`spikes/07-architect-mcp-spike/REPORT.md`, `docs/DECISIONS.md` #29) to be the *only* mechanism
that can admit OpenCode's MCP OAuth client, not a convenience choice among several: Managed
OAuth's `allowed_uris` field requires an `https://` URL, and OpenCode's default redirect
(`http://127.0.0.1:19876/mcp/oauth/callback`) is plain `http://` by design (OAuth 2.1's native-app
loopback exception), so there is no way to allow-list that specific URI instead. Dynamic Client
Registration (DCR), not the newer Client ID Metadata Documents (CIMD) mechanism the MCP
specification now prefers, is enabled for a similar reason, not a client-readiness gap this demo
chose to ignore: Cloudflare Access's `oauth_configuration` (confirmed against both the pinned
Terraform provider schema and the live Access applications API reference, both Beta) has no CIMD
field at all, so per the MCP spec's own client priority order, *every* client — even one that has
already migrated to CIMD elsewhere — falls back to DCR against this application regardless of its
own CIMD support. The access-token/session shape (`access_token_lifetime = "15m"`,
`session_duration = "336h"`) is Cloudflare's own recommended shape for CLI/agent use cases: a
client refreshes silently in the background, and Access re-evaluates policy on every refresh, so a
revoked identity is cut off within one token lifetime rather than only at initial login.

### Live sync and concurrency

`DiagramSession` (`src/worker/diagram-session/diagram-session.ts`) is a small, narrowly-scoped
Durable Object — one instance per diagram id (`env.DIAGRAM_SESSIONS.getByName(diagramId)`, no
separate mapping table) — that holds no durable data of its own. D1 remains the single source of
truth for a diagram's graph; this object exists purely as a live fan-out point for whichever
browser tabs currently have that diagram open. `GET /api/diagrams/:id/live`
(`src/worker/routes/diagrams.ts`) performs the same `DiagramRepository.findOwned()` ownership
check every other diagram route performs *before* forwarding the WebSocket upgrade to the Durable
Object — the object itself never re-derives authorization, matching this repository's usual
pattern of authorization living at the Worker/API boundary. It accepts sockets with the
[WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
(`ctx.acceptWebSocket()`, not `server.accept()`), so an idle open editor tab does not keep billing
the object while nothing is happening — consistent with this demo's existing cost-consciousness
elsewhere (ELK's lazy import, `demos/opencode-browser`'s `sleepAfter`). Its one RPC method,
`notifyGraphUpdated(graphData, updatedAt)`, is called by the Worker (never the browser) immediately
after a graph-mutating MCP tool call persists to D1, and sends a `graph_updated` frame to every
currently-accepted socket, skipping any socket no longer in the `OPEN` state rather than throwing.

On the client, `useDiagramLiveSync.ts` opens this WebSocket when `DiagramCanvas` mounts and closes
it on unmount; on a `graph_updated` frame newer than the store's own last-known `updatedAt`, it
replaces the Zustand store's graph state — reusing the same state-replacement the store already
performs after its own initial load, rather than a second code path — and `LiveUpdateToast.tsx`
shows a brief, dismissible "Updated by an agent" notice so the user understands why their canvas
just changed, rather than silently rewriting their screen with no explanation.

This channel is strictly server-to-client push: `DiagramSession` never accepts writes from the
browser side of the socket at all. The browser's own edits keep using the existing debounced `PUT
/api/diagrams/:id/graph` autosave path unchanged. Concurrency is plain last-write-wins, matching
this demo's existing autosave model (there is no partial-patch protocol; every autosave already
replaces the whole graph) — acceptable specifically because the only two writers on a diagram are
one owner's browser tab and that same owner's own agent, never two different people. If the user
is mid-edit when an agent's change arrives, the push replaces their canvas and their own in-flight
debounced autosave fires shortly after, overwriting the agent's change right back — a brief visual
flicker at worst, not data loss, since D1's `updated_at` always reflects whichever write actually
landed last; D1's own `UPDATE ... WHERE id = ? AND owner_email = ?` (already how `saveGraphData()`
works) makes the last statement to commit win outright if an agent's tool call and the browser's
autosave land in the same instant. Real concurrent-*editor* conflict resolution (two different
people editing the same diagram) remains explicitly out of scope, deferred to the same Post-MVP
collaboration work `docs/09-ARCHITECT.md` already named, which this design intentionally sets up
for: this identity/connection-lifecycle shape (one instance per diagram, Worker-side owner check
ahead of the upgrade, hibernated accept, fan-out to every connected socket) is the foundation that
future work would extend with a bidirectional channel and presence/cursor messages, not a second
Durable Object built from scratch.

Not implemented, and deliberately so: raster (PNG/SVG) export through the MCP server. Demo 9's
export is a client-side, DOM/canvas-based operation (`html-to-image` against the live React Flow
canvas) with no server-side browser-rendering step in this demo (Browser Run is not a listed
product for this add-on) — `export_diagram`'s `"json"` and `"scaffold"` formats are both pure data
transforms with no DOM dependency, so pixel-perfect raster export stays a browser-only action via
the editor's own toolbar button. Also deliberately not built: bridging these same tools into the
browser's own `navigator.modelContext` (the experimental [WebMCP](https://github.com/webmachinelearning/webmcp)
standard) via Cloudflare's `agents/experimental/webmcp` adapter — both the adapter and the
underlying browser API are explicitly experimental and unshipped as of this writing (Cloudflare's
own README: "this adapter **will break** between releases"), so this demo does not build against
either moving target; if WebMCP matures, it would layer on top of the remote MCP server already
built here, reusing these same tool implementations rather than rewriting them.

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
traces again.

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
- [`color-scheme` CSS property](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme) and [`light-dark()`](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark) — what `src/client/lib/theme.ts`'s dark mode toggle actually overrides.
- [`Window.print()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/print) and the [`@page` at-rule](https://developer.mozilla.org/en-US/docs/Web/CSS/@page) — print mode's orientation override.
- [html-to-image](https://github.com/bubkoo/html-to-image#readme) — rasterizes the React Flow viewport for PNG/SVG export.
- [fflate](https://101arrowz.github.io/fflate) — zips the generated project scaffold entirely in the browser.
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Cloudflare Agents: Model Context Protocol](https://developers.cloudflare.com/agents/model-context-protocol/)
- [MCP handler APIs (`createMcpHandler`)](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP Tools](https://developers.cloudflare.com/agents/model-context-protocol/protocol/tools/)
- [MCP Authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Secure MCP servers with Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [`cloudflare_zero_trust_access_application` resource (`oauth_configuration`)](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application)
- [Durable Objects: WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [ELK.js](https://github.com/kieler/elkjs) — why this demo's server-side `auto_layout_diagram` MCP tool uses a grid-placement fallback instead (does not run inside `workerd`; see `docs/DECISIONS.md` #29).
