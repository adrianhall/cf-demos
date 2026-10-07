# Architect — Engineering Specification

## 1. Purpose and scope

Architect is a Cloudflare architecture-diagram application. A user selects Cloudflare products from
a searchable catalogue, arranges and connects them on a React Flow canvas, adds detail, and persists
an autosaved diagram. They can start from a blueprint or blank canvas, manage their own diagrams,
share a read-only live link, export a PNG/SVG or project scaffold, and print. One
operator-designated administrator can inspect the user directory and remove diagrams.

The complete product grows in four capability layers described in
[`00-introduction.md`](./00-introduction.md): the single-user editor; MCP access and one-way live
sync; collaboration; and AI assistance. The source documents in `~/gitlab/cf-demos/docs/` are the
behavioural authority:

- `09-ARCHITECT.md` — editor, dashboard, sharing, administration, export, print, theme, and all 35
  reported and fixed defects.
- `09B-ARCHITECT-MCP.md` — remote MCP server and `DiagramSession` Durable Object.
- `09C-COLLABORATIVE-EDITING.md` — named collaborators, operations, presence, and cursors.
- `09D-ARCHITECT-AICHAT.md` — Workers AI-backed diagram generation and in-editor chat.
- `DECISIONS.md` entries 23–42 — verified platform constraints that must not be rediscovered.

This demo lives in `cf-terraform-demos/architect`. Its initial deployment target is
`cf-architect.cfapps.uk`, deliberately alongside the source deployment rather than replacing it —
see [§1.3](#13-naming-and-coexistence-with-the-source-deployment).

### 1.1 Product goals

1. Faithfully reproduce the source application's visible UI, interaction, copy, CSS, behaviour,
   data, and accessibility fixes before extending it.
2. Use Cloudflare's current `cf` control plane and Terraform v5, with a complete non-interactive
   provision/deploy/teardown lifecycle.
3. Refactor the Worker into the repository's four tiers without changing client-facing behaviour.
4. Demonstrate the least complex Cloudflare primitive for each need: D1 for durable relational data,
   KV for disposable share-token lookup, a Durable Object only for live coordination, and Workers
   AI/AI Gateway only in the AI layer.
5. Keep the source's security corrections: digest-only share tokens, no user-managed roles, and
   application-side authorization in addition to Access.

### 1.2 Explicit non-goals

- Re-designing or modernising the visual language, components, CSS, copy, routes, or client state
  while porting.
- Replacing React, `@xyflow/react`, Zustand, or the source's plain SPA route selection.
- Rewriting the source UI in Vue merely to match the other `cf-terraform-demos` demos.
- Adding unplanned Cloudflare products or an identity provider resource.
- Building the future layers before the preceding layer is complete and visually faithful.
- Server-side PNG/SVG capture. Raster/vector canvas export remains a browser concern; MCP export
  exposes JSON and project scaffold data instead.

### 1.3 Naming and coexistence with the source deployment

The source implementation stays live at `architect.cfapps.uk` for the whole port. It is the
reference for what "correct" looks like, so the port must not take its hostname, its Worker name, or
any Terraform-owned resource it depends on. The two deployments coexist in one account until the
port is verified.

The port therefore deploys as `cf-architect.cfapps.uk` initially, and **both the hostname and the
Worker name are Terraform input variables** rather than literals:

| Variable      | Initial value            | Governs                                                            |
| ------------- | ------------------------ | ------------------------------------------------------------------ |
| `worker_name` | `cf-architect`           | Worker registration, bootstrap deployment, and `cf workers delete` |
| `hostname`    | `cf-architect.cfapps.uk` | Custom hostname, Access application domains and destinations, DNS  |

Both values must flow from Terraform through to every consumer, so renaming is a change to two
variable values and nothing else:

- Terraform Worker/bootstrap/custom-hostname/Access resources, and the documented scalar outputs
  that expose them;
- committed `infra/local-outputs.json` and the ignored generated `infra/outputs.json`;
- `cloudflare.config.ts`, which resolves the Worker name and bindings from those outputs;
- the `deploy` and `teardown` scripts — notably `cf workers delete`, which must never hard-code a
  name that could resolve to the source deployment;
- Access application audiences and destination paths;
- `README.md`, `DEMO.md`, and any command or URL shown to a reader.

No source file, test, or script may hard-code either value. Tests that need a hostname derive it
from configuration or use an explicit fixture, so a rename cannot leave a stale literal behind.

**Cutover** is a deliberate, separate step taken only after the §7 acceptance conditions pass and
the parity review is signed off: destroy or release the source deployment's hostname, change the two
variables to `architect` and `architect.cfapps.uk`, then re-apply and re-deploy. Until that point,
`architect.cfapps.uk` must keep working.

## 2. Porting contract

### 2.1 Fidelity rule

The source application is working prior art, not a loose inspiration. Client files are copied as
whole units wherever their dependencies permit it, then adapted only at seam points:

- API module URLs, response shapes, and error handling;
- Access identity source and logout URL;
- import paths and configuration;
- the Worker API behind the client;
- framework-independent tooling changes required by this repository.

All other client differences require a written decision in the relevant implementation phase. A
change in geometry, colour, font, markup, navigation, or interaction is a regression until a source
document or a new approved requirement justifies it.

### 2.2 Must-port inventory

The following source assets are common application code, not candidates for replacement:

| Area             | Source material to port                                                                           | Requirement                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Styling          | `src/client/app.css`                                                                              | Port in full before component work. Preserve `--cf-*` token names, system font stack, brand `#f6821f`, `light-dark()` values, responsive breakpoints, print rules, and explanatory contrast comments. |
| Static/data      | `catalog.ts`, `blueprints.ts`, vendored official icons                                            | Preserve the 42-product catalogue, categories, 8 blueprints, graph schema, labels, descriptions, doc links, and icon approach.                                                                        |
| Shell            | `App.tsx`, `AppHeader`, `DarkModeToggle`, views                                                   | Preserve the plain path switch and real-document navigations across the Access boundary.                                                                                                              |
| Editor           | canvas, custom nodes/edges, palette, properties/details, toolbar, connection modal, Zustand store | Preserve all interaction and keyboard paths, including the accessible connection dialog.                                                                                                              |
| Creation/gallery | blueprints gallery, real React Flow previews, create modal                                        | Preserve filtering, blank canvas, category pills, preview rendering, and the source's two-column create form.                                                                                         |
| Directory/admin  | dashboard cards/grid, deletion modal, admin tables                                                | Preserve card overlay/link behaviour, relative timestamps, previews, and moderation surface.                                                                                                          |
| Sharing/export   | share controls/view, export/print/scaffold modules                                                | Preserve one-time share URL display, live-pointer semantics, client-side exports and print mode.                                                                                                      |
| Hooks/utilities  | modal focus, dismissable menus, identity, preferences, datetime, auto-layout                      | Preserve behaviour and tests; substitute only the API/access seam.                                                                                                                                    |

### 2.3 Visual and built-artifact contracts

DOM tests are insufficient for this port: jsdom does not calculate layout, apply production CSS as a
browser does, or provide font metrics. The demo must consequently retain three complementary checks:

1. **Local browser verification.** `pnpm start` must serve the actual CSS and application shell; no
   phase is accepted if local visual review requires a deployment.
2. **Built stylesheet contract.** A Worker/project test reads the production build output and
   asserts the font stack, `#f6821f`, every required `--cf-*` token, and unlowered `light-dark()`.
   This catches build-only CSS transformations rather than merely validating source text.
3. **Phase-boundary side-by-side review.** Review the local/deployed port against the surviving
   source deployment, `architect.cfapps.uk`, at desktop and narrow widths. Capture screenshots only
   as review evidence, not as fragile pixel tests.

## 3. Client application

### 3.1 Host and routes

The client is React + TypeScript built by Vite and served from the Worker's Static Assets binding.
It uses a small path selector, not client-side route transitions across the Access boundary:

| Path                | Access posture                    | View                                 |
| ------------------- | --------------------------------- | ------------------------------------ |
| `/`                 | public                            | Landing page and hero diagram        |
| `/blueprints`       | public                            | Blueprint gallery and creation modal |
| `/s/:token`         | public                            | Read-only shared-diagram viewer      |
| `/app`              | authenticated                     | Personal diagram dashboard           |
| `/app/diagrams/:id` | authenticated                     | Editor                               |
| `/app/admin`        | authenticated + application admin | User directory and moderation        |

Links into `/app*` are ordinary anchors. Access then protects the document request before any
protected client view runs. The client may read `window.location.pathname` and derive a diagram ID
from the path; it must not replace this boundary with an SPA history transition.

### 3.2 Identity-aware shell

The common header is source-compatible:

- anonymous public views show brand, appearance control, and **Sign in**;
- authenticated views show verified identity, **My Diagrams**, appearance control, **Sign out**, and
  **Admin** only when `/api/me` reports `isAdmin`;
- the editor deliberately suppresses the common header and uses its source toolbar/back control;
- public identity lookup treats an Access challenge as anonymous rather than an error;
- chrome links use the source's non-underlined navigation treatment; prose links retain normal link
  affordance.

The theme control cycles system → light → dark → system. System preference has no stored override;
light/dark do. Fixed icon dimensions prevent the control's size changing between states.

### 3.3 Editor and accessibility baseline

The editable and read-only canvases use `@xyflow/react` and the exact source visual model:

- a searchable, collapsible catalogue palette with persisted collapsed category choices;
- accessible click fallback for adding a service, plus drag/drop where available;
- Cloudflare product and generic actor nodes with official inline SVG icons;
- typed edges, labels, protocols and reduced-motion-aware data-flow animation;
- properties and details panels, initially collapsed, auto-opening on selection and usable as
  responsive overlay drawers below 900px;
- undo/redo, pan/zoom/fit view, debounced autosave, lazy browser-side ELK auto-layout, and an
  accessible native-form **Connect nodes** dialog;
- a visually-hidden page heading and a visible canvas focus indicator;
- a real computed-height full-viewport editor container so `fitView` measures usable geometry;
- a read-only mode that disables every editing control and does not expose a misleading tab stop.

React Flow thumbnails are decorative. They are `aria-hidden`, `inert`, pointer-inert,
`nodesFocusable={false}`, and `edgesFocusable={false}`. Nothing focusable may live under an
`aria-hidden` preview.

### 3.4 Create-diagram journey

The public blueprint page is the starting point for creation. A card opens the source-compatible
modal over that page, rather than navigating to an unrelated dashboard form:

- title and close (`×`) control, where close is equivalent to Cancel;
- left column: category/type pills and a non-interactive miniature of the selected graph;
- right column: title and description fields, seeded from a blueprint; blank canvas starts with its
  intended blank description;
- Cancel and **Create diagram** controls in the lower-right action area;
- focus initialisation, trap, Escape close, focus restoration, and 24px minimum close target.

**My Diagrams → Create diagram** navigates to `/blueprints`; it does not open a contextless form.
The gallery has All/Serverless/AI/Media filtering, contains a permanent blank-canvas card, shows
real graph previews, makes the complete card one link/control, and uses a button-styled visible
action inside that single activation target.

### 3.5 Client data contract

The client consumes JSON APIs only through dedicated client API modules. It never calls D1, KV, or a
Durable Object directly. State-changing calls send exact `application/json`, include normal
same-origin browser credentials, surface RFC 9457 errors accessibly, and avoid logging diagram data
or share tokens.

## 4. Worker architecture

### 4.1 Tier boundaries

Dependencies flow only down this chain:

```text
Client UI → HTTP/API routes → application services → domain + ports → infrastructure adapters
```

| Tier           | Owns                                                                                             | Must not own                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Routes         | Hono route registration, verified identity extraction, request limits/parsing, HTTP status/shape | D1/KV construction, business validation, authorization decisions beyond invoking a service |
| Application    | use cases, actor/owner/admin decisions, transactions across ports, audit/log events              | Hono request/response objects, concrete bindings                                           |
| Domain         | graph/data validation, types, pure graph mutations, share-token digest rules                     | bindings, fetch, storage, identity headers                                                 |
| Ports          | interfaces for diagrams, shares, users, collaborators and live-session gateway                   | concrete D1/KV implementation                                                              |
| Infrastructure | D1/KV adapters, Durable Object implementation, external Cloudflare clients                       | transport-specific policy or duplicated business rules                                     |
| Composition    | one composition root creates adapters/services and injects routes                                | user-visible application logic                                                             |

Public repository methods are authorization-neutral. Application services take a verified actor and
return a non-enumerating `404` for inaccessible diagrams. An adapter never receives a raw request or
trusts a caller-provided actor.

### 4.2 Shared Worker concerns

Use `@demos/worker-common` wherever it provides the concern:

- `createAccessMiddleware({ buildPolicies, enableDevTokens: import.meta.env.DEV })` for Access;
- `currentIdentity()` / `currentIdentityEmail()` for every actor;
- `createMeRouter()` for `/api/me`, adding an admin middleware only where required;
- `jsonBodyLimit()` then `readJsonBody()` for JSON requests;
- `upgradeRequired()` for a non-WebSocket request to a live endpoint.

Use `@adrianhall/cloudflare-toolkit` for structured logging, guards and RFC 9457 error handling.
Every operational failure returns `application/problem+json`; deployed responses never expose a
stack trace.

### 4.3 Access and authorization

Terraform creates two path-specific Access applications on the same hostname:

- a hostname-wide public bypass for `/`, `/blueprints`, and `/s/*`;
- an authenticated application for `/app*`, authenticated APIs, and, later, `/mcp*`.

The Worker validates the Access JWT audience for each protected API request; edge Access alone is
not authorization. The shared path-policy builder is reused in production middleware and local
Access emulation. Every API policy has `redirect: false`.

`ADMIN_EMAIL` is a Terraform-provided Worker variable. Only a verified email equal to this value is
an administrator. The database has no role column and no promote/demote workflow. Admin routes
re-check this server-side even if UI visibility was gated by `/api/me`.

All mutations require an allowed same Origin and JSON media type. The authenticated middleware
upserts a lightweight `users` directory entry as a best-effort side effect; the directory is never
an authorization source.

### 4.4 Data and repositories

D1 is the authoritative durable store:

- `diagrams(id, owner_email, title, description, graph_data, created_at, updated_at)`;
- `users(email, display_name, first_seen_at, last_seen_at)`;
- `diagram_shares(token_digest, diagram_id, created_at, revoked_at)`;
- later `diagram_collaborators(diagram_id, collaborator_email, added_by, added_at)`.

Schema comments explaining deliberate omissions — especially no `users.is_admin`, no persisted raw
share token, and the source's FK trade-off — move with the migrations.

KV `SHARES` is a disposable fast lookup from SHA-256 digest to diagram id. D1 is authoritative for
share lifecycle. Raw share tokens exist only in the create response shown once to the owner; they
are never stored, logged, or returned by status/list operations.

### 4.5 HTTP surface — Layer 1

Exact response fields are defined alongside route tests, but the public contract includes:

| Route                                     | Behaviour                                                           |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/me`                             | Verified identity and `isAdmin`.                                    |
| `GET/POST /api/diagrams`                  | List own diagrams; create from valid blueprint or blank canvas.     |
| `GET/PATCH/DELETE /api/diagrams/:id`      | Read, update metadata, or delete only an owned diagram.             |
| `PUT /api/diagrams/:id/graph`             | Validate and replace an owned graph; debounced client autosave.     |
| `POST /api/diagrams/:id/duplicate`        | Duplicate only an owned diagram.                                    |
| `GET/POST/DELETE /api/diagrams/:id/share` | Get status, rotate/create one-time share URL, revoke.               |
| `GET /api/shares/:token`                  | Public read-only resolution with a deliberately limited projection. |
| `GET /api/admin/users`                    | Administrator-only paginated directory.                             |
| `DELETE /api/admin/diagrams/:id`          | Administrator-only moderation delete and share cleanup.             |

Anonymous share resolution remains public even though it is an API path. It must be excluded from
the authenticated Access application's destinations and cannot mutate state.

## 5. Future capability layers

### 5.1 MCP and one-way live sync

`POST /mcp` uses Cloudflare Access Managed OAuth on the existing authenticated Access application;
there is no machine identity, service token, extra application, or separate allow-list.

MCP tools call application services in-process: list/get/create/rename/delete diagrams; granular
node/edge mutation; auto-layout; share lifecycle; and JSON/scaffold export. Graph mutations are pure
domain functions followed by validation, service persistence, and live notification.

`DiagramSession` is one Durable Object per diagram id. It holds no authoritative durable graph: D1
remains the one durable copy. The Worker authorizes an upgrade before forwarding the request to the
object; the object accepts it with `ctx.acceptWebSocket()` for hibernation. A non-upgrade gets 426.
The initial live channel is server → browser only, broadcasting a persisted MCP update.

The Worker removes every inbound identity-header spelling before setting its verified value. The
object may trust it because it has no directly routable endpoint; each accepted socket serializes
the verified actor into its attachment for use after hibernation.

### 5.2 Collaboration

Collaboration adds named existing users as editors. Owner-or-collaborator authorization happens in
application services before an upgrade or mutation reaches the session.

The existing `DiagramSession` evolves rather than a second object appearing. It receives and
serializes idempotent node/edge operations, persists each to D1 before broadcast, retains D1 as its
only durable store, and uses presence/cursor/selection frames only as transient state. No CRDT is
needed: operations target stable node/edge ids and the single object gives them an order; an atomic
field replacement is last-writer-wins.

### 5.3 AI assistance

AI turns run inside the same `DiagramSession`, so they survive a closed browser tab and broadcast
changes exactly as a human or MCP client does. Workers AI is reached through AI Gateway, with
per-turn observability/correlation. The agent uses the source's restricted tool vocabulary and
Cloudflare documentation MCP grounding; it never writes arbitrary graph JSON outside the shared
operation service.

## 6. Infrastructure, tooling, and lifecycle

### 6.1 Configuration and ownership

`cloudflare.config.ts` uses `defineWorker()` and `defineConfig()` as the typed configuration source
of truth. Local/test mode uses committed `infra/local-outputs.json`; production mode reads ignored
`infra/outputs.json` written after Terraform applies. Generated Worker binding types live under
`.cloudflare/types/` and are included by TypeScript but never committed.

Terraform v5 owns Worker registration/bootstrap deployment, the `worker_name`/`hostname` variables
and the resources derived from them ([§1.3](#13-naming-and-coexistence-with-the-source-deployment)),
D1, KV, Access resources, and future Durable Object/AI Gateway configuration. `cf` owns the built
Worker upload and bindings. Terraform never uploads source; `cf` never recreates Terraform
resources. Explicit dependency edges make reverse teardown safe.

Lifecycle is exactly:

```text
pnpm start     local simulated resources and Access
pnpm deploy    Terraform apply → write outputs → remote D1 migration → Vite build → cf deploy --prebuilt
pnpm teardown  cf workers delete → cleanup bound resources where needed → Terraform destroy
```

### 6.2 Required scripts and quality gates

The package defines `start`, `check`, `fix`, `deploy`, `teardown`, and `test`, composed using
`npm-run-all2` namespaced steps. `check` is write-free and covers generated types, strict
TypeScript, Oxfmt `--check`, type-aware Oxlint, Terraform validate/fmt-check, and built CSS contract
checks. `fix` performs Oxfmt, safe lint fixes, and Terraform formatting only.

TypeScript is strict with unused-local/parameter and fallthrough checks. Public exports and
non-trivial helpers have complete JSDoc. Oxfmt and Oxlint configuration inherit root policy;
React/TypeScript requirements are declared in the demo-local Oxlint config.

### 6.3 Testing

Vitest has client (jsdom + React Testing Library), worker (pure domain/application), and Workers
runtime integration projects. Runtime tests apply D1 migrations through `readD1Migrations()` and
`applyD1Migrations()`, run offline, include a finite timeout, and test real authorization results.

Istanbul covers all authored `src/**/*.{ts,tsx}` and targets at least 80% statements, branches,
functions, and lines. Coverage does not replace visual review or built-CSS contracts.

## 7. Non-negotiable acceptance conditions

1. `pnpm check`, `pnpm test`, and coverage all pass from a clean checkout.
2. `pnpm start` works after only root `.env` setup and displays the real CSS.
3. `pnpm deploy` followed by `pnpm teardown` is idempotent and leaves no named/billable resources.
4. Every protected API validates Access audience and actor; every mutation rejects absent/foreign
   origin and non-JSON input.
5. No actor can enumerate another owner's diagram, including via share or live routes.
6. Only `ADMIN_EMAIL` can use every administrative endpoint.
7. Share tokens are digest-only in D1/KV/logs and exposed raw exactly once on creation.
8. The source's accessibility fixes remain present, including modal focus management, 24px targets,
   form/node contrast, keyboard connection, reduced motion, focusable-preview prevention, and
   responsive sidebars.
9. The port matches source CSS tokens, typography, component layout, and interaction at each phase
   boundary, with any intentional difference documented before merge.
