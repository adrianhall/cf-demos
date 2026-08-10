# Architect — What This Demo Teaches

Architect is a Cloudflare architecture diagram editor: an authenticated user drags Cloudflare
product icons onto a canvas, connects them, and gets an autosaved, shareable, exportable
diagram. This file explains the Cloudflare capabilities it demonstrates and the key design
decisions behind how it works.

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

ELK (`elkjs`), the auto-layout engine, is imported with a dynamic `import()` only when a user
actually clicks a layout button (`src/client/components/editor/toolbar/Toolbar.tsx`), rather than
bundled into the main chunk — bundling it eagerly adds roughly 540 KB gzip to the initial page
load for a feature many users never use, so lazy-loading keeps the feature without paying that
cost up front.

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
this is a client-only SPA. `AppShellView`'s header wraps both the dashboard and the editor, so one
`DarkModeToggle` instance there covers both; `BlueprintsView`'s own header and the editor
`Toolbar` each render their own instance for the pages `AppShellView` doesn't wrap.

ELK remains the only heavy, lazy-loaded dependency in this editor; `html-to-image` and `fflate`
are small enough (roughly 15 KB and 8 KB gzip respectively) to import eagerly in
`ExportButton.tsx` without meaningfully affecting the initial load.

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
