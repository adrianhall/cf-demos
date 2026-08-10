# Demo 9: Architect

Directory: `demos/architect`

Domain: `architect.cfapps.uk`

Status: Plan finalized — all open questions resolved (see [Decisions](#decisions)
below; the standalone Open Questions section has been folded into the plan).
See [Post-MVP](#post-mvp-live-collaboration-and-ai-proposals)
for what that means for a future collaboration/AI specification.
[Phase 0](#phase-0---spike-tag-phase-00-spike) is complete — see
`spikes/06-architect-reactflow-host/REPORT.md`; no `demos/architect` code exists
yet.

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, and
Workers KV. Durable Objects, Workflows, Workers AI, and R2 are explicitly out
of scope for this plan — see [Post-MVP](#post-mvp-live-collaboration-and-ai-proposals).

## Summary

CF-Architect (`~/repos/adrianhall/CF-Architect`) is a real, working
Cloudflare-architecture-diagram tool: a curated product catalog, drag-and-drop
editing on `@xyflow/react`, blueprint templates, PNG/SVG/project-scaffold
export, print mode, dark mode, a personal dashboard, admin user management,
and anonymous read-only sharing. It runs on Astro (SSR) + React islands +
Drizzle ORM over D1, with hand-rolled Cloudflare Access JWT verification and
custom Node scripts (`firstrun.mjs`/`deploy.mjs`/`teardown.mjs`) standing in
for Terraform-owned infrastructure and `@adrianhall/cloudflare-toolkit`.

This demo ports that application's *functionality* onto this repository's
conventions: Hono for the Worker API, a React single-page app served through
the Static Assets binding (no Astro, no SSR), Terraform owning every
Cloudflare resource per this repository's baseline contract, and
`@adrianhall/cloudflare-toolkit` for Access enforcement, structured logging,
RFC 9457 errors, and local-dev Access emulation. React is an explicit,
justified exception to this repository's Vue default (see AGENTS.md's
scenario-override clause): CF-Architect is real, working prior art built on
React and `@xyflow/react`, and rewriting its UI in Vue would be pure
translation effort with no new teaching value — the value in this demo is
porting real functionality onto this repository's infrastructure and backend
conventions, not re-proving that a diagram editor can be built in Vue (this
repository's prior Vue attempt at this same demo already proved that).

Catalog data, blueprint templates, and the overall node/edge visual model are
ported directly — they are data and product design, not framework-coupled
code. React component structure (`CFNode`, `CFEdge`, `ServicePalette`,
`PropertiesPanel`, `Toolbar`, the Zustand store shape) may be used as a close
structural reference and adapted, since the rendering library
(`@xyflow/react`) and framework family (React) do not change. The **backend**
is not a light port: Drizzle ORM, the custom auth strategy, and the custom
deploy/teardown scripts are replaced outright with this repository's raw-D1 +
`cloudflare-toolkit` + Terraform conventions, per the [Terraform And
Toolkit Gap Analysis](#terraform-and-toolkit-gap-analysis) findings below.

This is an MVP scope: live multi-user collaboration and AI-generated
proposals — the previous, from-scratch plan's original differentiators — are
deliberately deferred rather than built now. See
[Post-MVP](#post-mvp-live-collaboration-and-ai-proposals).

## Decisions

Four design forks were raised as open questions and resolved as follows.
Each decision is threaded into the relevant section below; this list exists
only as a single point of reference back to the reasoning.

1. **Scope** — MVP is CF-Architect parity only (Phases 0–6 below). Live
   collaboration and AI proposals are real, wanted features, but are
   deliberately left unspecified here and will get their own specification
   once this MVP ships — see [Post-MVP](#post-mvp-live-collaboration-and-ai-proposals).
2. **Admin / Identity Provider** — Drop Terraform-provisioned GitHub-only
   IdP; keep the admin feature, but re-key it on a single operator-configured
   `ADMIN_EMAIL` value instead of a D1 `is_admin` role column and
   promote/demote workflow. See [Access Model](#access-model) and
   [Phase 4](#phase-4---admin-tag-phase-04-admin).
3. **Sharing model** — Keep CF-Architect's live-pointer share link (a share
   always reflects the diagram's current state); fix the underlying security
   bug by storing only a SHA-256 digest of the token, never the raw value.
   See [Phase 3](#phase-3---sharing-tag-phase-03-sharing).
4. **Prior Vue implementation** — Already deleted; this is a clean start in
   the same directory and on the same domain (see the dashboard-verification
   note in Status above before Phase 1 provisions infrastructure).

## Goals

- Reach feature parity with CF-Architect's catalog, editor, blueprints,
  dashboard, admin user management, export, print mode, and dark mode,
  running on Hono + React + Terraform + `cloudflare-toolkit`.
- Fix the security issues found in CF-Architect's current implementation
  while porting: plaintext share tokens, the committed Terraform state file,
  and the unused `SESSION` KV namespace.
- Give every Cloudflare resource (Worker, custom domain, D1, KV, Access) an
  explicit Terraform owner with the bootstrap-deployment, `subdomain` block,
  and `depends_on` patterns this repository requires.
- Make every state-changing API enforce Cloudflare Access and same-origin
  checks through `cloudflareAccess()`, not a hand-rolled JWT verifier.

## Non-Goals

- Pixel-perfect parity with CF-Architect's Astro page structure or Drizzle
  schema — only its user-facing behavior is the target.
- Live multi-user collaboration and AI-generated proposals — deliberately
  deferred; see [Post-MVP](#post-mvp-live-collaboration-and-ai-proposals).
- GitHub as a provisioned Identity Provider — this demo relies on whichever
  IdP(s) the account's Access team already has configured.
- Complex organization roles beyond a single designated admin identity.
- Generated deployment-ready Terraform or application source code beyond what
  this plan's phases describe.

## Terraform And Toolkit Gap Analysis

These findings came from reading CF-Architect's `terraform/`, `wrangler.toml`,
`scripts/`, `src/middleware.ts`, `src/lib/auth/`, and `src/env.d.ts`. Every
item below is a **settled** decision for this port — they follow directly
from this repository's AGENTS.md baseline, not from a preference call.

**Terraform:**

- CF-Architect commits an empty `terraform.tfstate` at its repository root
  (tracked since the commit that introduced Terraform) and has no
  `cloudflare_worker` resource at all — the Worker is entirely unmanaged by
  Terraform; `wrangler deploy` creates it implicitly. This port's Terraform
  must never commit state, and must own the Worker resource with an explicit
  `subdomain` block, the bootstrap-deployment placeholder pattern, and
  `depends_on` from the Worker to D1 and KV.
- CF-Architect deploys to a bare `*.workers.dev` hostname; this repository
  requires a custom domain in an active zone (`architect.cfapps.uk`, matching
  the domain already assigned to this demo slot), provisioned with
  `cloudflare_workers_custom_domain`.
- CF-Architect's single Access application covers every protected path with
  no explicit public-bypass application; this port uses the two-application
  pattern (hostname-wide public `bypass`, plus a more specific authenticated
  application scoped to protected destinations).
- CF-Architect hand-writes `terraform/terraform.tfvars` from `.env` inside a
  custom `firstrun.mjs` script; this port uses the `dotenv` Terraform provider
  to read `.env` directly, and deletes that script.
- The Cloudflare provider is pinned to `~> 5.0`; this port pins `~> 5.22.0`
  per this repository's baseline.
- Terraform provisions a `SESSION` KV namespace that `src/env.d.ts` never even
  types and nothing in `src/` ever reads. This port drops it — it is dead
  infrastructure, not a feature to preserve.
- CF-Architect provisions a `cloudflare_zero_trust_access_identity_provider`
  for GitHub. This port drops it (see [Decisions](#decisions) #2) — Access
  authentication relies on the account's already-configured IdP(s), like
  every other demo in this repository.

**Wrangler / deployment scripts:**

- CF-Architect edits a committed `wrangler.toml` in place via string
  replacement inside `deploy.mjs` to inject real resource IDs and strip
  `DEV_MODE`. This port uses one committed `wrangler.jsonc.tpl` with
  `{{placeholder}}` markers, `infra/local-outputs.json` for local
  substitution, and the toolkit's `generate-wrangler`/`generate-wrangler-types`
  CLIs — this repository's standard pattern (see the `cloudflare-deploy-scripts`
  skill).
- `firstrun.mjs`, `deploy.mjs`, and `teardown.mjs` are hand-written
  orchestration scripts. This port replaces them with composed
  `npm-run-all2` `package.json` scripts, matching every other demo in this
  repository.
- CF-Architect states no explicit Workers Logs sampling rate. This port sets
  one explicitly in `wrangler.jsonc.tpl`.

**`cloudflare-toolkit`:**

- CF-Architect does not depend on `@adrianhall/cloudflare-toolkit` at all.
  `src/middleware.ts` hand-verifies the `Cf-Access-Jwt-Assertion` header with
  `jose` and returns ad-hoc `{ ok: false, error: {...} }` JSON on failure.
  This port uses the toolkit's framework-agnostic core (`/guards`, `/errors`,
  `/problem-details`, `/logging`) everywhere, and — because the API layer
  moves to Hono (see [Architecture](#architecture)) — the `/hono` middleware
  (`cloudflareAccess()`, `cloudflareLogger()`, `problemDetailsErrorHandler()`)
  and `/vite`'s `cloudflareAccessPlugin()` for local development, replacing
  the hand-rolled verifier entirely.

## Architecture

- **Worker**: a Hono app is the Worker's `fetch` handler, mounted under
  `/api/*`. Static Assets (`ASSETS` binding, SPA fallback) serve the React
  build for every other route. `run_worker_first` covers `/api/*` only —
  every page route is served directly by the assets layer, exactly like this
  repository's existing Vue demos, per AGENTS.md's guidance that Access
  already gates page routes at the edge before the Worker is involved.
- **Client**: React 19 + `@xyflow/react`, Vite + `@vitejs/plugin-react` +
  `@cloudflare/vite-plugin`, Zustand for editor state (kept from CF-Architect
  — a reasonable, framework-appropriate choice with no repository convention
  against it). No Astro, no server-rendered pages; this is a single-page app
  like every other demo here, just built with React instead of Vue.
- **Data**: raw D1 (`env.DB`) with `@adrianhall/cloudflare-toolkit/guards`
  (`throwIfNull`, `sqlCount`) instead of Drizzle ORM — no other demo in this
  repository uses an ORM, and the toolkit's guards are designed around raw
  `.first()`/`.all()` result shapes. D1 migrations run through Wrangler
  (`db:migrate:local`/`db:migrate:remote`, `CI=1`), replacing Drizzle's
  migration generator. Workers KV (`SHARES`) is the fast anonymous
  share-token lookup, matching CF-Architect's own existing KV usage for
  sharing.
- **Auth**: `cloudflareAccess()` on every `/api/*` route (audience
  validated), paired with `cloudflareAccessPlugin()` in `vite.config.ts` for
  local development, replacing the hand-rolled `jose` verifier. Admin
  authorization is a second, independent check layered on top — see
  [Access Model](#access-model).
- **Observability**: `cloudflareLogger()` for request-scoped structured
  logging, `problemDetailsErrorHandler()`/`notFoundHandler()` for RFC 9457
  error responses, explicit Workers Logs sampling and tracing in
  `wrangler.jsonc.tpl`.
- **Testing**: this repository's standard three-Vitest-project layout —
  `src/worker/vitest.config.ts` (node, pure domain logic), `src/client/vitest.config.ts`
  (jsdom, React Testing Library instead of Vue Test Utils), and
  `tests/integration/vitest.config.ts` (`@cloudflare/vitest-pool-workers`
  against real bindings) — replacing CF-Architect's single flat Vitest config
  and hand-rolled `sqlite-db.ts`/`mock-kv.ts` fakes.

## Access Model

Two Access applications on `architect.cfapps.uk`, per AGENTS.md's Public
Access pattern:

- A hostname-wide public `bypass` application for the landing page,
  `/blueprints`, and the read-only share viewer.
- A more specific authenticated application with explicit destinations for
  `/app*` and `/api/*`, backed by an `allow` policy for **any authenticated
  identity** — no Identity Provider is provisioned by Terraform; this demo
  relies on whichever IdP(s) the account's Access team already has
  configured, matching every other demo in this repository.

Mount `cloudflareAccess()` on every `/api/*` route and validate the
authenticated application's audience. Use one shared path-policy array in the
Worker and `cloudflareAccessPlugin()` for local development, with at least two
selectable local identities and an unconditional `/cdn-cgi/access/logout`
control. Require same-origin requests and an exact JSON content type for
every state-changing API request.

**Admin authorization is independent of Access policy.** A single
operator-configured `ADMIN_EMAIL` value (an `.env`/Terraform variable
threaded through to a Worker var, the same pattern AGENTS.md's Public Access
section already documents for an "expected-identity Worker variable") is
compared against the verified identity's email by a small Hono middleware
applied to every admin-only route — not just a "whoami" endpoint. `GET
/api/me` returns `{ email, isAdmin }` so the client can conditionally render
admin UI without duplicating the check. There is no D1 role column, no
first-user-becomes-admin bootstrap, and no promote/demote workflow: exactly
one identity is ever the admin, and it is set by the operator, not the
application.

## What We're Porting From CF-Architect

| Feature | CF-Architect today | Disposition in this port |
| --- | --- | --- |
| Product catalog (~30 nodes, 6 categories) | `src/lib/catalog.ts` | Port data directly. |
| Blueprint templates (8 templates) | `src/lib/blueprints.ts` | Port data directly. |
| Diagram canvas, palette, properties panel, undo/redo | React islands + Zustand | Port and adapt; same libraries, new host app. |
| Autosave (debounced `PUT`) | `DiagramCanvas.tsx` | Port. |
| Personal dashboard (list/create/rename/delete/duplicate) | `DiagramList.tsx` + `/api/v1/diagrams` | Port. |
| PNG/SVG/project-scaffold export | `ExportButton.tsx`, `html-to-image`, `scaffold.ts` | Port. |
| Print mode | `PrintButton.tsx` | Port. |
| Dark mode | `src/lib/preferences.ts` (pure `localStorage`) | Port as-is — no backend involvement. |
| Read-only anonymous sharing | `/s/:token`, `ShareRepository` | Port with the live-pointer model retained; fix the security bug by storing only a SHA-256 digest of the token, never the raw value, in D1 and as the KV key. |
| Admin user management | `/api/v1/admin/users/*`, `users.is_admin`, first-user-becomes-admin | Redesigned, not dropped: a single operator-configured `ADMIN_EMAIL` replaces the D1 role column and bootstrap logic. Since there is now exactly one admin, promote/demote no longer applies; the admin view becomes a read-only user directory plus diagram moderation (view/delete any user's diagram). See [Phase 4](#phase-4---admin-tag-phase-04-admin). |
| GitHub-only Identity Provider | Terraform `cloudflare_zero_trust_access_identity_provider` | Dropped — relies on the account's already-configured Access IdP(s), like every other demo in this repository. |
| `thumbnail_key` column | `src/lib/db/schema.ts` (commented "post-MVP", never implemented) | Drop — dead column, not a feature to preserve. |
| ELK auto-layout | Shipped in the main bundle | Port, but lazy-load it on first use (dynamic `import()`) instead of bundling it up front — CF-Architect ships it eagerly, but this repository's prior Vue attempt at this same demo measured a 539.52 kB gzip cost for the equivalent Vue library and deferred it for exactly that reason. Lazy-loading keeps the feature without the up-front cost. |

## Data Model (D1)

- `diagrams`: `id`, `owner_email`, `title`, `description`, `graph_data`
  (JSON), `created_at`, `updated_at`. `owner_email` replaces CF-Architect's
  `owner_id` foreign key into its own `users` table, since Access identity
  *is* the user.
- `users`: `email` (primary key), `display_name`, `first_seen_at`,
  `last_seen_at`. A lightweight directory only, upserted by the shared auth
  middleware on every authenticated request (matching CF-Architect's own
  upsert-on-auth pattern). It exists solely to back the admin user-directory
  view (Phase 4) — it is never consulted for authorization. There is
  deliberately no `is_admin` column: admin status is `ADMIN_EMAIL`, not data.
- `diagram_shares`: SHA-256 token digest (never the raw token), `diagram_id`,
  `created_at`, optional `revoked_at`. Simpler than a revision-addressed
  scheme because the live-pointer model always reads the diagram's current
  `graph_data` at request time — there is no snapshot to key by revision.

## Implementation Plan

### Phase 0 - Spike (tag: `phase-00-spike`)

**✅ Complete — see `spikes/06-architect-reactflow-host/REPORT.md`.** Confirmed clean on every
question below: the plain Vite/React/Cloudflare host needs nothing Astro-specific reproduced for
the diagram canvas itself (CF-Architect's own editor page already opts out of Astro SSR via
`client:only="react"`), and `cloudflareAccessPlugin()` coexists cleanly with
`@cloudflare/vite-plugin` + `@vitejs/plugin-react` (full local login/logout round trip
live-verified). Two concrete, reusable findings for later phases: every `/api/*` Access policy
entry needs an explicit `redirect: false` (the dev plugin's navigation-vs-API detection can
otherwise redirect an API caller to the login page instead of returning JSON — see the report's
§3), and Phase 2's multi-page app will need its own client-side way to read a diagram's `:id` out
of the URL, since a plain SPA has no server-side router to thread it through as a prop the way
Astro's file-based routing did. Real pointer-based drag-and-drop interaction could not be
verified with an automated real browser in the spike's environment; the report recommends a
two-minute manual click-test of the spike as the first thing done in Phase 1.

**Unknown to prove:** whether `@xyflow/react`, its custom node/edge renderers,
palette drag-and-drop, and a true read-only mode behave the same wired
directly into `@cloudflare/vite-plugin` + a plain React SPA as they do inside
CF-Architect's Astro-island architecture — and whether
`cloudflareAccessPlugin()` coexists cleanly with that setup. This is a narrow,
single-spike unknown (unlike the previous Vue plan's four spikes): React Flow
itself is mature, well-documented, and already proven in CF-Architect: the
only real open question is the surrounding host app, not the diagram library.

**Probe:** a small local page with five catalog products, one external actor,
two edge types, editable properties, and a read-only toggle, served through
`@cloudflare/vite-plugin` with no Astro involved, plus `cloudflareAccessPlugin()`
gating it locally.

**Report must decide:** whether Astro added anything load-bearing that the
plain Vite/React/Cloudflare setup needs to reproduce, and confirm the final
dependency versions.

### Phase 1 - Scaffolding And Access (tag: `phase-01-scaffolding`)

1. **Before provisioning anything**, verify in the Cloudflare dashboard that
   no resources remain from the previous Vue implementation on
   `architect.cfapps.uk` (see the note in Status above); clean up manually if
   Terraform state for it is unrecoverable.
2. Create `demos/architect` with the canonical layout: Hono, React 19,
   TypeScript, Vite, `@cloudflare/vite-plugin`, `@vitejs/plugin-react`.
3. Provision with Terraform: Worker registration, bootstrap deployment,
   custom domain, the two Access applications/policies (no Identity Provider
   resource — see [Access Model](#access-model)), D1, KV, Workers Logs, and
   tracing. Explicit `depends_on` from the Worker to D1 and KV.
4. Commit one `wrangler.jsonc.tpl` and `infra/local-outputs.json`. Bind `DB`
   and `SHARES`; configure Static Assets SPA fallback and run the Worker
   first only for `/api/*`.
5. Wire local and production Wrangler generation, generated binding types, D1
   local/remote migrations, build, check, test, deploy, and complete
   teardown.
6. Add global logging, RFC 9457 errors, `cloudflareAccess()`, shared access
   policies, local Access emulation, an auth middleware that upserts the
   `users` directory row on every authenticated request, `GET /api/me`
   (returns `{ email, isAdmin }`, comparing against `ADMIN_EMAIL`), a public
   landing page, an authenticated empty app shell, and logout.
7. Add `ADMIN_EMAIL` to `.env.example`, as a Terraform variable, and as a
   Worker var.
8. Create the initial D1 migration for `diagrams` and `users` (see [Data
   Model](#data-model-d1); `diagram_shares` is added in Phase 3).

**Testing:** verify Access on page/API paths, public bypass paths, the
`ADMIN_EMAIL` comparison in `GET /api/me`, binding generation, migrations,
and the empty responsive shell.

**Definition of done:** `npm run deploy` can produce an empty secure app and
`npm run teardown` leaves no named or billable resources.

### Phase 2 - Diagram Library And Editor (tag: `phase-02-editor`)

1. Port the product catalog and blueprint template data.
2. Implement owner-scoped diagram list/create/open/rename/duplicate/delete
   APIs and a raw-D1 repository, replacing Drizzle.
3. Port the editor: searchable product palette, product/actor nodes, typed
   labeled edges, properties panel, undo/redo, autosave, pan/zoom/fit, and
   the blueprint gallery.
4. Port the dashboard (diagram card grid, rename, duplicate, delete).
5. Emit `diagram_created`, `diagram_opened`, and `diagram_updated` structured
   logs without graph content or user email.

**Testing:** cover graph validation, owner isolation, editor interactions,
blueprint creation, and dashboard actions.

**Definition of done:** one authenticated user can create, edit, reload,
reopen, duplicate, and delete diagrams, matching CF-Architect's current
single-user behavior.

### Phase 3 - Sharing (tag: `phase-03-sharing`)

1. Add owner-only share create/revoke APIs. Store only a SHA-256 token digest
   — never the raw token — in D1 and as the KV key; the live diagram is read
   at request time, so there is no snapshot to keep in sync.
2. Build the read-only viewer and owner share controls (copy link, revoke).
3. Emit `diagram_shared` and `diagram_share_revoked` logs without tokens or
   graph content.

**Testing:** prove anonymous access to a valid share, unpublished/unknown/
revoked behavior, that a live edit is immediately visible through an existing
share link (the live-pointer model working as intended), and that raw tokens
never appear in request URLs, logs, or storage.

**Definition of done:** the owner can share a read-only link without exposing
edit access, with no plaintext token anywhere.

### Phase 4 - Admin (tag: `phase-04-admin`)

1. Add the `ADMIN_EMAIL`-comparison middleware (introduced in Phase 1) to
   every admin route; return `403` for any other authenticated identity.
2. Add `GET /api/admin/users` (paginated directory: email, display name,
   diagram count, first/last seen) and `DELETE /api/admin/diagrams/:id`
   (moderation delete of any user's diagram).
3. Build the admin UI — user directory table, and the ability to open or
   delete any user's diagram — gated by `isAdmin` from `GET /api/me`.
4. Emit `admin_diagram_deleted` structured logs without graph content.

**Testing:** prove every non-`ADMIN_EMAIL` authenticated identity gets `403`
on every admin route; prove the `ADMIN_EMAIL` identity can list users and
delete any diagram; prove a deleted diagram cascades its shares.

**Definition of done:** the operator-designated admin can view every user's
diagrams and remove any diagram; no other identity can.

### Phase 5 - Export, Print, And Preferences (tag: `phase-05-export`)

1. Port PNG/SVG export and the project-scaffold ZIP generator.
2. Port print mode.
3. Port dark mode (client-only `localStorage` preference).

**Testing:** cover export filename generation, scaffold ZIP contents, and
print-mode side effects.

**Definition of done:** feature parity with CF-Architect's export, print, and
theme behavior.

### Phase 6 - Verification, Documentation, And Cleanup (tag: `phase-06-complete`)

1. Close coverage gaps across the three Vitest projects.
2. Run formatting, linting, type checking, coverage, production build,
   Wrangler generation/type checks, `terraform fmt -check`, and `terraform
   validate`. Run the `web-perf` review and a WCAG 2.2 AA review.
3. Verify single-command deploy and teardown.
4. Write `README.md`, `DEMO.md`, and `EXPLAIN-DEMO.md`. Add accurate JSDoc to
   every authored TypeScript declaration.

**Definition of done:** the complete ported feature set — including admin —
is reproducible, all verification passes, and teardown leaves no demo
resources.

## Phase 7: Bugs

Every bug below except Bug 8 was fixed in one pass; Bug 8 was explicitly excluded from that pass
(it needs its own, larger, dedicated fix) and is carried forward, unresolved, in
[Phase 9](#phase-9-carried-forward-bugs). That pass also surfaced two more issues while verifying
the ones listed here -- Bug 23 (two still-stacked editor banners) and Bug 24 (the data-flow edge
animation this port inherited from CF-Architect never actually rendered) -- also recorded in
Phase 9 and Bug 22 respectively; see those entries for detail. A third issue, Bug 25 (icon-only
buttons showing the wrong background in light mode), was found and fixed after this phase had
already shipped.

### Bug 1: Sign out should be a clear button with an icon

**Fixed.** `AppShellView.tsx`'s sign-out control is now a visible `.button` with a `react-feather`
`LogOut` icon plus the "Sign out" text, instead of a bare text link.

### Bug 2: Zoom in/out, fit view, share, undo/redo, export, print, etc. should be made into a toolbar in the top banner rather than creating their own banner.  The toolbar should also be made of icons

**Fixed in place, banner merge deferred.** Every `Toolbar.tsx`/`ExportButton.tsx`/
`PrintButton.tsx`/`DarkModeToggle.tsx` control is now icon-only (`react-feather`), grouped with
separators, each keeping its original `title` string as a tooltip and matching `aria-label`.
Moving this toolbar into `AppShellView.tsx`'s single top banner was **not** done in this pass --
`ReactFlowProvider` currently wraps only `EditorView.tsx`, one level below `AppShellView`'s
header, so the toolbar's `useReactFlow()` calls (zoom/fit/export) aren't reachable from there
without restructuring which component owns the provider. See Bug 23 in
[Phase 9](#phase-9-carried-forward-bugs) for that follow-up.

### Bug 3: There should be a collapse all / uncollapse all in product catalog

**Fixed.** `ServicePalette.tsx` has a "Collapse all"/"Expand all" control above the category
list, toggling every category section at once.

### Bug 4: Node editor (panel on right hand side) should be collapsed initially, collapsible or closeable with a close icon button, and open automatically when a node is selected

**Fixed.** `diagramStore.ts`'s `propertiesOpen` defaults to `false` and is set to `true` by
`setSelectedNode`/`setSelectedEdge` whenever a non-null id is passed; deselecting leaves it open
showing its empty state rather than auto-closing. `PropertiesPanel.tsx` has its own close button
(a `react-feather` `X`), and the toolbar has an explicit toggle for it (and a matching one for
the service palette, `paletteOpen`).

### Bug 5: (administrator) replaced by icon (maybe shield?)

**Fixed.** `AppShellView.tsx` renders a `react-feather` `Shield` (`role="img"`,
`aria-label="Administrator"`) next to the verified email instead of the literal
`" (administrator)"` text suffix.

### Bug 6: "Architect" title is repeated in banner and header

**Fixed.** `Toolbar.tsx`'s text "Architect" logo/back-to-dashboard link is now an icon-only
`ArrowLeft` (same destination, same `title="Back to dashboard"`), so "Architect" no longer
appears twice when the app shell header and the editor toolbar are both visible at once.

### Issue 7: Validate product set against the current Cloudflare product set and explicitly via ~/repos/adrianhall/cloudflare-docs/src/icons

**Fixed.** `catalog.ts` was reconciled against Cloudflare's current product set and its own
`cloudflare-docs` icon set:

- Renamed two products that Cloudflare itself renamed: AutoRAG → AI Search, Browser Rendering →
  Browser Run (`typeId` kept as `autorag`/`browser-rendering` so previously saved diagrams still
  resolve to a valid catalog entry).
- Added ten current products with no prior catalog entry: Containers, Sandbox, Pipelines, R2 SQL,
  R2 Data Catalog, Secrets Store, Realtime, Workers VPC, Turnstile, and Email Service (distinct
  from the existing Email Routing).
- Replaced every hand-drawn placeholder icon with a byte-identical vendored copy of Cloudflare's
  own official icon (`src/client/icons/`, sourced from
  `~/repos/adrianhall/cloudflare-docs/src/icons/`), rendered inline via the new
  `src/client/components/ProductIcon.tsx` so they can be recolored with `currentColor` and survive
  `ExportButton.tsx`'s `html-to-image` PNG/SVG capture (a CSS `mask-image` approach does not --
  see `docs/DECISIONS.md`). The four "External / Generic" node types, which aren't Cloudflare
  products, use `react-feather` icons instead, as does `cron-trigger` (a Workers trigger
  configuration, not a standalone product with its own official icon).
- Documented, rather than papered over, five icon collisions already present in Cloudflare's own
  icon set (Workers/Workflows/Workers VPC, R2/R2 Data Catalog, Containers/Sandbox,
  Agents/AI Gateway, Email Routing/Email Service) -- each pair still reads as distinct on canvas
  via category color, accent border, and label.

### Bug 9 (high): Form field borders fail non-text contrast (1.4.11)

**Fixed.** Every text input/select/textarea now uses a new `--cf-field-border` custom property
(`light-dark(rgba(0, 0, 0, 0.45), rgba(255, 255, 255, 0.35))`, ≥3.3:1 against both `--cf-surface`
and `--cf-surface-alt` in both themes) instead of the decorative-only `--cf-border`, which stays
reserved for section dividers.

### Bug 10 (high): Unselected node borders fail non-text contrast (1.4.11)

**Fixed.** `CFNode.tsx` now renders its border at full opacity in both the selected and
unselected states (selection is distinguished by the existing box-shadow ring instead), and
`CATEGORY_COLORS`'s `storage`/`network` values were darkened from Cloudflare's original brand hex
(`#10B981`/`#F59E0B`, ~2.5:1/~2.2:1 against white) to `#0D9467`/`#B87608` (≥3.85:1/≥3.3:1 against
both `--cf-surface` values in both themes); the other four category colors already cleared 3:1
at full opacity.

### Bug 11 (high): `--cf-danger` is not theme-aware, failing dark-mode text contrast (1.4.3)

**Fixed.** `--cf-danger` is now `light-dark(#c0392b, #ff8a75)` (≥5.4:1/≥7.4:1 against
`--cf-surface` in both themes). `.button--danger`'s solid fill uses a new, separate
`--cf-danger-solid: #c0392b` instead, since a filled button supplies its own contrast context
independent of the surrounding page theme.

### Bug 12 (high): No visible focus indicator on the diagram canvas (2.4.7)

**Fixed.** Added `.diagram-editor:focus-visible { outline: 2px solid var(--cf-orange);
outline-offset: -2px; }` to `app.css`.

### Bug 13 (high): Modals don't manage focus (2.4.3 / 4.1.2)

**Fixed.** A new shared `useModalFocus(open, dialogRef, onClose)` hook (initial focus,
Tab/Shift+Tab trap, `Escape`-to-close, focus restoration on close) is wired into `ShareModal`,
`CreateDiagramModal`, and `ConfirmDeleteModal`. Each modal's backdrop-dismiss button is
`tabIndex={-1}` and excluded from the trap -- it remains a pointer/touch-only dismissal target,
with `Escape` and the dialog's own visible controls as the keyboard paths. `inert` on the app root
was not used: these modals render inline in the app tree rather than through a portal, so
inerting the app root would inert the dialog itself.

### Bug 14 (moderate): Layout-direction menu has different menu semantics than the other two overflow menus

**Fixed.** The layout-direction chevron button now has `aria-haspopup="menu"`, and its popup has
`role="menu"`/`"menuitem"`, matching `ExportButton` and `DiagramGrid`'s `CardMenu`.

### Bug 15 (moderate): Export menu and layout-direction menu can't be dismissed by keyboard

**Fixed.** A shared `useDismissableMenu(open, containerRef, onDismiss)` hook (outside `mousedown`
and `Escape`) replaced the three near-duplicate effects in `CardMenu`, `ExportButton`, and the
toolbar's layout-direction menu.

### Bug 16 (moderate): Diagram card nests an interactive button inside an anchor

**Fixed.** `DiagramGrid.tsx`'s card is now a non-interactive `<div>`; only the title is wrapped in
an `<a>`, stretched via a `::after` overlay to cover the whole card (a "block link" pattern), with
`CardMenu` as a sibling `<button>` that still receives clicks in the overlapping region.

### Bug 17 (moderate): Modal close buttons are under the 24x24 CSS px minimum target size (2.5.8)

**Fixed.** `.modal__close` and `.diagram-card__menu-button` both have explicit
`min-width: 24px; min-height: 24px;` with centered content.

### Bug 18 (moderate): Catalog item descriptions are only exposed via a hover tooltip (1.3.1)

**Fixed.** `ServicePalette.tsx`'s palette items show the description as visible, 2-line-clamped
text below the label. The button's accessible name stays just the product label (`aria-label`),
with the description linked via `aria-describedby` rather than concatenated into the name, so a
screen reader announces the label and then, after a pause, the description. `title` is kept as a
hover hint.

### Bug 19 (moderate): Editor page has no top-level heading, and skips a heading level (2.4.6 / 1.3.1)

**Fixed.** `DiagramCanvas.tsx` renders a visually-hidden `<h1>{title} — Diagram editor</h1>` at
its top, kept in sync with the store's `title` -- covering both the authenticated editor and the
read-only share viewer, which renders the same component.

### Bug 20 (moderate): Share viewer page has no landmark (1.3.1)

**Fixed.** `ShareView.tsx` now wraps its banner and `DiagramCanvas` in `<main
className="share-view">`.

### Bug 21 (moderate): Editor sidebars have no responsive breakpoint (1.4.10)

**Fixed.** Below a 900px breakpoint, `.service-palette` and `.properties-panel` become
absolutely-positioned overlay drawers over `.diagram-editor__canvas` (`.diagram-editor__body`
gained `position: relative` as their containing block) instead of sitting side-by-side with it,
so the canvas always gets the viewport's full width regardless of which sidebars are open. Each
remains toggleable with the same Bug 4 toolbar controls above the breakpoint.

### Bug 22 (minor): Animated data-flow edges ignore `prefers-reduced-motion`

**Fixed -- and misdiagnosed above.** The original description assumed the animation worked and
only needed a `prefers-reduced-motion` guard; verification found the animation itself was dead
code (see Bug 24). Fix, once the animation actually rendered: `app.css` defines a `cf-edge-animated`
class/`@keyframes cf-edge-dashdraw` pair applied directly to the edge `<path>`
(`CFEdge.tsx`), guarded by `@media (prefers-reduced-motion: reduce) { .cf-edge-animated {
animation: none; } }`.

### Bug 24 (found during Bug 22's verification, now fixed): Data-flow edge animation never actually rendered

`CFEdge.tsx` set a `react-flow__edge-animated` class on `BaseEdge`'s `<path>`, but
`@xyflow/react`'s real stylesheet only defines `.react-flow__edge.animated path` -- a selector
keyed off the *parent* `<g>` wrapper's class, which `EdgeWrapper` (a `@xyflow/react` internal,
outside this app's control) only adds when the edge's own top-level `Edge.animated` property is
`true`. Nothing in this app ever set that property, so the class name on the `<path>` matched
nothing, and "data-flow" edges have never actually animated in this port. Fixed by defining this
app's own `cf-edge-animated` class/`@keyframes cf-edge-dashdraw` pair in `app.css`, applied
directly to the `<path>` `CFEdge.tsx` already controls, sidestepping `@xyflow/react`'s
wrapper-class mechanism entirely -- see Bug 22 above for the accompanying
`prefers-reduced-motion` guard.

### Bug 25 (high, found and fixed after this phase shipped): Icon-only buttons show the wrong background in light mode

Reported after Bug 2/6's icon-only toolbar conversion shipped, against a real production build:
buttons rendered with a dark background behind a dark icon in light mode -- effectively invisible
-- while the icon itself tracked the active theme correctly; toggling the in-app dark-mode
control changed the icon's color immediately but left every button's background stuck.

Two things were tried before finding the real cause. First, `appearance: none` on every
`<button>` (a real, independently-worth-keeping fix for a different, unrelated class of bug --
native OS button chrome overriding author styles -- but not what was actually happening here,
confirmed by testing didn't fix the symptom). Second, `vite dev` was tested directly and rendered
every button correctly in both themes, in both Chromium and WebKit (via a throwaway Playwright
script) -- ruling out `app.css`'s actual color logic and pointing at something specific to a
*production build*.

Root cause, found by diffing the built CSS: Vite 8's `build.cssMinify` defaults to Lightning CSS,
which -- independent of configured browser targets -- downlevels every `light-dark()` value
(`app.css`'s entire theming system, e.g. `--cf-surface: light-dark(#fff, #1c1c1e)`) into a pair
of custom properties toggled by a `@media (prefers-color-scheme: dark)` rule. That media query
evaluates against the browser/OS's *raw* preference and has no way to see the `color-scheme` CSS
property this app sets programmatically (`../lib/theme.ts`'s `applyTheme()`, via
`document.documentElement.style.colorScheme`) to let a user override the OS preference in-app --
so every `light-dark()`-based background/border silently stopped responding to the in-app toggle
the moment the app was built for production, while unset `color` properties (relying on the
browser's own *native*, non-polyfilled `color-scheme` handling for default text color) kept
working, producing exactly this symptom. `vite dev` never minifies CSS, so this was invisible in
local development. Fixed in `vite.config.ts` with `css.lightningcss.exclude: Features.LightDark`
(from the `lightningcss` package, now an explicit `devDependency`), which keeps `light-dark()`
passed through as native CSS unconditionally -- justified because every browser this demo needs
to support already ships it natively (Chrome/Edge 123+, Safari 17.5+, Firefox 120+). Verified by
rebuilding, confirming zero polyfill artifacts in the output CSS, and re-running the same
Playwright script against the built, `vite preview`-served bundle. See `docs/DECISIONS.md` #27
for the full writeup, including why the `appearance: none` fix was kept anyway.

## Phase 8: Catalog Video Doc Links

`catalog.ts`'s `DocLinkIcon` type (`"doc" | "video"`) and `PropertiesPanel.tsx`'s `VideoIcon`/
`DOC_LINK_ICONS` were ported faithfully from CF-Architect, but neither this port's catalog nor
CF-Architect's own ever actually sets `icon: "video"` on any product's `docLinks` — the video
icon has been dead, uncovered code in both apps since the original. Phase 6's test review
surfaced this as `PropertiesPanel.tsx`'s only remaining coverage gap with no defensible
"leave uncovered" justification (see Bug 8's siblings above; this one is a real content gap, not
a provably-unreachable branch).

1. Pick a handful of catalog products (`src/catalog.ts`'s `NODE_TYPES`) that have a genuinely
   useful official Cloudflare tutorial/overview video, not just written docs — a demo/tutorial
   video, not a marketing page.
2. Add one `{ icon: "video", title, url }` entry to each chosen product's `docLinks` array,
   alongside its existing `icon: "doc"` entries.
3. Extend `PropertiesPanel.test.tsx`'s existing "renders documentation links for a node type that
   has them" test (or add a sibling test) to select a node with a video doc link and assert the
   video icon renders, closing the coverage gap with a real assertion instead of a workaround.

**Definition of done:** at least one real catalog product has a working `icon: "video"` doc
link, `VideoIcon` is exercised by a real test, and `PropertiesPanel.tsx` has no remaining
coverage gap for either doc-link icon variant.

### List of video links

- Workers: <https://www.youtube.com/watch?v=42E8DWdZgYc>
- Workers: <https://www.youtube.com/watch?v=H7Qe96fqg1M>
- D1: <https://www.youtube.com/watch?v=egBdW6vBIhM>
- D1: <https://www.youtube.com/watch?v=9brMQnc01Yc>
- D1: <https://databaseschool.com/series/high-performance-sqlite/videos/1>
- Hyperdrive: <https://www.youtube.com/watch?v=TQyPeDejcEI>
- Workflows: <https://www.youtube.com/watch?v=1EhbW2UI3W0>
- Durable Objects: <https://www.youtube.com/watch?v=k4UXEfZf3sc>
- Queues: <https://www.youtube.com/watch?v=ZDv4iYaLbpI>
- Email Service: <https://www.youtube.com/watch?v=Bf_cEzAIUPU>
- Email Service: <https://www.youtube.com/watch?v=0pil4xQXIVE>
- Browser Run: <https://www.youtube.com/watch?v=s5PQE8bklNY>
- Dynamic Workers: <https://www.youtube.com/watch?v=Z9-wwXaoA68>
- AI Search: <https://www.youtube.com/watch?v=Z8LtULldcyQ>
- AI Gateway: <https://www.youtube.com/watch?v=hkJ_dglOlV8>
- RealTimeKit: <https://www.youtube.com/watch?v=z4ZQIjN3I7k>
- Turnstile: <https://www.youtube.com/watch?v=QKFiN_cyeMc>
- Containers: <https://www.youtube.com/watch?v=MFA1RRuTxqY>
- Containers: <https://www.youtube.com/watch?v=oyOaxMY4eNo>
- Vectorize: <https://www.youtube.com/watch?v=A4b_qgNzlSw>
- Workers AI: <https://www.youtube.com/watch?v=A4b_qgNzlSw>
- R2: <https://www.youtube.com/watch?v=ywIZmfMk138>
- R2: <https://www.youtube.com/watch?v=d4gDBQlC-Ro>
- R2: <https://www.youtube.com/watch?v=ohfg-lCt6hc>
- R2: <https://www.youtube.com/watch?v=TIp5sUZO4Uo>
- Durable Objects: <https://databaseschool.com/series/durable-objects/videos/328>

## Phase 9: Carried-Forward Bugs

Every Phase 7 bug except the two below was fixed in that phase's own pass; these are the ones
that weren't, carried forward here rather than left silently unresolved in a phase already marked
complete.

### Bug 8 (critical): Diagram edges can only be created by mouse-drag, with no keyboard alternative

Moved from Phase 7 unchanged -- deliberately excluded from that phase's fix pass because it needs
its own, larger, dedicated design (a click-to-connect mode, not a small isolated change like its
Phase 7 siblings).

WCAG 2.2 SC 2.5.7 (Dragging Movements, AA) / 2.1.1 (Keyboard, A). Creating an edge between two
nodes is only possible by dragging from one `Handle` to another
(`src/client/components/editor/DiagramCanvas.tsx`'s `onConnect`, wired straight to
`@xyflow/react`'s pointer-drag connection flow) — there is no click/keyboard-activatable
alternative anywhere in the store or UI. Node repositioning is partially mitigated by the
"Auto layout" button, but connecting nodes has zero alternative. Since building an architecture
diagram *is* connecting nodes, this makes the primary workflow fully inoperable for
keyboard-only and switch-access users. Fix: add a click-to-connect mode (click a source handle
or select a node then press a "Connect" toolbar action, then click a target handle/node to
complete the edge), mirroring `ServicePalette`'s existing click-fallback pattern for node
creation.

### Bug 23 (moderate): Editor still shows two stacked banners

Found while fixing Phase 7's Bug 2, which fixed everything about that bug *except* this: the
authenticated editor route renders both `AppShellView.tsx`'s app-shell header (identity,
dark-mode toggle, sign-out) and `Toolbar.tsx`'s own banner immediately below it (now icon-only
per Bug 2, but still a second, separate bar) — Bug 2 asked for one unified toolbar in the top
banner, not two banners where one merely looks more like a toolbar now.

The fix is a real structural change, not a small one: `Toolbar.tsx` calls `useReactFlow()`
(zoom/fit/export), which requires a `ReactFlowProvider` ancestor; that provider currently wraps
only `EditorView.tsx`, one level *below* `AppShellView.tsx`'s header in the component tree, so the
header has no access to it today. Fixing this means hoisting `ReactFlowProvider` up into
`AppShellView` for the editor route, collapsing `EditorView.tsx` into `AppShellView.tsx`, moving
`Toolbar`'s rendering out of `DiagramCanvas.tsx` into that hoisted header, and having
`ShareView.tsx` render `<Toolbar readOnly />` in its own single banner instead of the two
separate ones it also currently has (its own `.share-view__banner` plus `Toolbar`). Every
existing icon button's `title`/`aria-label` from the Bug 2 fix should carry over unchanged.

Request is that the very top bar (which includes the title, admin link, username, and sign-out button) is removed from the editor view; this can just be removed - no buttons need to be moved into the editor toolbar for this (including the signout button)

### Bug 26 Sign-out button is malformed

The sign-out button contains a sign-out icon followed by the words "Sign out".  The icon is not vertically centered, so it appears slightly above the "Sign out" words.  In addition, there is no gap between the icon and the words, resulting in a compressed look.

### Bug 27 Remove the "admin" icon next to the email address in the banner

the "shield" admin icon is not required, nor is the old "administrator" wording - the fact that there is an "Admin" link in the banner is enough to denote the admin capabilities.

### Bug 28: The Label and Description input boxes overlap edge in the detail panel

Click on a node, then the detail panel opens on the right hand side.  Note the label and the description text boxes are flush against the edge (with no horizontal scroll bar).  Need a small amount of gap for a pleasing UX.

### Bug 29: Newly created diagram isn't visible on editor canvas

Create a new diagram; select API gateway; open editor.  Expectation is that the diagram is shown on the editor canvas.  Instead, the diagram nodes are out of the view port and you have to scroll to see the diagram.  The proper way is that the diagram is "fit to view" and centered on the view port when you open the editor.

## Post-MVP: Live Collaboration And AI Proposals

Live multi-user collaboration (one Durable Object per diagram, hibernatable
WebSockets, presence, remote cursors) and Workflow-backed AI proposal
generation (`ArchitectureWorkflow`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
through `env.AI`) were the previous, from-scratch plan's original
differentiators. They are real, wanted features — not rejected — but are
deliberately out of scope for this MVP (see [Decisions](#decisions) #1)
rather than carried here as phase-by-phase detail that would go stale before
it is built.

The prior research on this — `spikes/06-architect-vue-editor` through
`spikes/10-architect-workflow-deployed`, which had already settled real
unknowns (Durable Object SQLite transaction shape, WebSocket close codes,
Workflow step boundaries, the verified Workers AI model and schema adapter)
— has been removed along with the Vue implementation it supported. A future
collaboration/AI specification cannot treat those unknowns as settled and
will need to re-run equivalent spikes from scratch (they are no longer
Vue-specific unknowns in any case, since this plan is React-based); it should
also resolve how Phase 1–6's D1-column diagram storage migrates to Durable
Object SQLite once a diagram becomes collaboratively editable — a real
migration cost, not a detail to gloss over when that work is scoped.

## Non-Negotiable Tests

- Every authenticated API route rejects an unauthenticated request; public
  routes cannot mutate a diagram.
- State-changing API requests reject missing or foreign origins.
- A non-owner cannot discover, read, edit, share, or revoke another user's
  diagram.
- Every admin route rejects every identity except `ADMIN_EMAIL` with `403`.
- Share tokens are never stored, logged, or returned in plaintext — only
  their SHA-256 digest.
- Public shares return only the intended read-only fields and never
  membership or admin data.
- Teardown removes Worker, D1, KV, Access, and custom-domain resources, and
  leaves no committed Terraform state.

## Key Risks

- **Astro-coupling surprises:** CF-Architect's Astro middleware and adapter
  may do more implicit work (redirects, cookie handling) than the STRUCTURE.md
  survey caught. Phase 0's spike exists specifically to surface this before
  Phase 1 commits to the plain Vite/React architecture.
- **Scope creep back toward the previous plan:** it remains easy to slide
  back into building live collaboration or AI proposals mid-implementation,
  even though the prior spike research for them no longer exists in this
  repository to lean on. Treat Phases 0–6 as the complete, demo-able MVP;
  Post-MVP work needs its own specification — and its own from-scratch
  spikes — first.
- **Security regressions during the port:** CF-Architect's plaintext share
  tokens and committed Terraform state are real bugs in working prior art;
  porting code structure without also porting the fix (digest-only token
  storage) is a real risk to guard against explicitly in review.
