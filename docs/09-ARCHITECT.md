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

### Bug 1: Sign out should be a clear button with an icon

### Bug 2: Zoom in and Zoom out should have icons

### Bug 3: There should be a collapse all / uncollapse all in product catalog

### Bug 4: Node editor (panel on right hand side) should be collapsed initially, collapsible or closeable with a close icon button, and open automatically when a node is selected.

### Bug 5: Fit view should have an icon

### Bug 6: Share button should be an icon button

### Bug 7: (administrator) replaced by icon (maybe shield?)

### Bug 8: "Architect" title is repeated in banner and header

### Bug 9: Toolbar (Undo/redo/etc. + share) should be in the top banner

### Issue 10: Validate product set against the current Cloudflare product set and explicitly via ~/repos/adrianhall/cloudflare-docs/src/icons

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
