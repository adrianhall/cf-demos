# Architect — A Cloudflare-centric Architecture Diagram Tool

## 1. Overview

**Architect** is a web application for drawing Cloudflare architecture diagrams. A signed-in user
drags Cloudflare product icons from a searchable catalog onto a canvas, connects them with typed
edges, annotates them, and gets an autosaved diagram they can share read-only with anyone, export as
PNG/SVG, or download as a runnable project scaffold.

That is the product. The reason it is worth building as a demo is what sits underneath it: a single
hostname that is simultaneously public and authenticated, a diagram that four different kinds of
actor can edit through one code path, and a Durable Object that exists for exactly one reason —
coordinating live connections — while D1 stays the only durable copy of anything.

This is a **re-implementation** of `~/gitlab/cf-demos/demos/architect`, which is itself a port of
the original `CF-Architect` Astro application. The functionality is settled and proven; what changes
here is the platform underneath it:

| Aspect                   | Existing `cf-demos/architect`                        | This re-implementation                                              |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Deployment control plane | Wrangler (`wrangler.jsonc.tpl`, `generate-wrangler`) | `cf` CLI with a typed `cloudflare.config.ts`                        |
| Application framework    | React SPA on Vite, client-side path switch           | **Unchanged** — same SPA shape, same path switch (see §5.1)         |
| Package manager          | npm                                                  | pnpm workspace                                                      |
| Formatting and linting   | Biome                                                | Oxfmt and type-aware Oxlint (`oxlint-tsgolint`)                     |
| Environment              | Per-demo `.env`                                      | Repository-root `.env`                                              |
| Shared Worker concerns   | Hand-rolled per demo                                 | `@demos/worker-common` and `@adrianhall/cloudflare-toolkit`         |
| Worker structure         | Feature folders (`diagrams/`, `shares/`, …)          | Four tiers (`routes` → `application` → `domain` → `infrastructure`) |

The product behaviour, the presentation layer, and the client component structure are a **faithful
port**. The deployment control plane, the tooling, and the Worker's internal layering are not — they
are rebuilt to this repository's conventions.

Note what is deliberately _absent_ from that table: the application framework. An earlier attempt at
this re-implementation moved the UI onto a server-rendered framework, and that decision is reversed.
§5.1 explains why, because it is the single most important lesson this document carries.

## 2. Source material

The complete behavioural specification for this demo lives in four stacked documents in the source
repository. Read them before implementing; they contain the reasoning behind decisions this document
only states.

| Document                                                                                                                       | Covers                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`~/gitlab/cf-demos/docs/09-ARCHITECT.md`](file:///Users/ahall/gitlab/cf-demos/docs/09-ARCHITECT.md)                           | The core editor: catalog, blueprints, canvas, dashboard, sharing, admin, export, print, theme — plus 35 numbered bug reports and their fixes.                                                                |
| [`~/gitlab/cf-demos/docs/09B-ARCHITECT-MCP.md`](file:///Users/ahall/gitlab/cf-demos/docs/09B-ARCHITECT-MCP.md)                 | A remote MCP server at `POST /mcp` authenticated by Cloudflare Access Managed OAuth, and the `DiagramSession` Durable Object that pushes an agent's edits live into an open editor tab.                      |
| [`~/gitlab/cf-demos/docs/09C-COLLABORATIVE-EDITING.md`](file:///Users/ahall/gitlab/cf-demos/docs/09C-COLLABORATIVE-EDITING.md) | Two signed-in humans editing one diagram at once, with presence, remote cursors, and a granular operation protocol replacing whole-graph last-write-wins.                                                    |
| [`~/gitlab/cf-demos/docs/09D-ARCHITECT-AICHAT.md`](file:///Users/ahall/gitlab/cf-demos/docs/09D-ARCHITECT-AICHAT.md)           | An AI assistant that builds and edits diagrams through the same operation vocabulary, running inside `DiagramSession`, reaching Workers AI through AI Gateway and Cloudflare's own documentation MCP server. |

`~/gitlab/cf-demos/docs/DECISIONS.md` entries #23–#42 record the platform behaviours each of those
documents discovered the hard way. Several are load-bearing and are carried forward into
[`01-specification.md`](./01-specification.md) as requirements rather than left as folklore.

## 3. What this demo teaches

### One hostname, two Access postures

The landing page, the blueprint gallery, and a read-only share link are genuinely public. The
dashboard, the editor, every management API, and the MCP endpoint require an authenticated identity.
Both live on one hostname, resolved by two Cloudflare Access applications — a hostname-wide bypass
and a narrower, path-scoped authenticated application — with the Worker re-validating the audience
as defence in depth.

The share resolver is the interesting case: it sits under `/api/`, where everything else
authenticates, and is deliberately left out of the authenticated application's destinations so it
falls through to the public one. Getting that ordering wrong in either Terraform or the shared
policy list breaks a visibly different thing in each place, which makes it a good lesson.

### Admin authorization that is not an Access policy

Exactly one identity is the administrator, named by an operator-configured `ADMIN_EMAIL` value.
There is no role column, no promote/demote flow, and no first-user-wins bootstrap. Access answers
_who is this_; the application answers _what may they do_, and it answers it again on every admin
route rather than trusting a `/api/me` response the browser could have faked.

### Digest-only secret storage with a visible product consequence

A share link's token is hashed with SHA-256 before it touches storage. Only the digest is persisted,
in D1 and as the Workers KV key. This is not an invisible good practice — it changes the product:
the server genuinely cannot answer "what is my diagram's share link?" afterwards, so the owner UI
has to show the link exactly once, at creation. That trade-off being visible on screen is the point.

### A Durable Object with a deliberately narrow job

`DiagramSession` — one instance per diagram — holds open WebSocket connections and nothing else. D1
remains the diagram's only durable copy at every moment, including while a live session is active.
The object keeps an in-memory read-through cache and a write chain, both disposable; losing them to
hibernation costs one extra D1 read and nothing more.

That restraint is the lesson. The obvious design gives the object its own SQLite copy and flushes it
periodically, and that design has a failure mode nothing else in the demo has to think about: two
independently persisted copies of one diagram that can silently disagree.

### Four actors, one write path

By the final layer, a diagram's graph can be changed by a person dragging a node, a person's own
external AI agent over MCP, a second person collaborating live, or an AI assistant in the sidebar.
All four produce the same granular operation, applied by the same `applyOperation()` call, persisted
by the same write chain, and broadcast to every other connected viewer identically. An
assistant-driven change is exactly as durable and exactly as visible as a human's, and is undoable
with Ctrl+Z like any other.

### Non-browser OAuth through the same Access application

An MCP client such as OpenCode authenticates as the same identity, against the same identity
provider, under the same policy as a person opening the editor — via Access's Managed OAuth
capability on the _existing_ application. No second application, no allow-list of "agent users", no
service token, no machine principal.

## 4. Capability layers

The product is delivered as four layers. Each is independently shippable and independently
demonstrable, and the demo is worth deploying at every boundary.

### Layer 1 — The editor (from `09-ARCHITECT.md`)

The complete single-user product: a 42-product Cloudflare catalog with official vendored icons, 8
blueprint templates, a drag-and-drop canvas with typed edges and a properties panel, undo/redo,
debounced autosave, a personal dashboard with live thumbnail previews, anonymous read-only sharing,
a single-admin user directory with diagram moderation, PNG/SVG/project-scaffold export, print mode,
and a dark mode that respects both the OS preference and an in-app override.

Products: Workers, Static Assets, Cloudflare Access, D1, Workers KV.

### Layer 2 — Agent access (from `09B-ARCHITECT-MCP.md`)

A remote MCP server at `POST /mcp` exposing the diagram catalog, CRUD, granular graph mutation,
sharing, and export as typed tools — every one of them calling the same application services the
HTTP API uses, in-process. Plus `DiagramSession`, whose only job at this layer is pushing a fresh
graph to every open editor tab the instant an agent changes something.

Products added: Durable Objects, Access Managed OAuth.

### Layer 3 — Collaboration (from `09C-COLLABORATIVE-EDITING.md`)

An owner grants edit access to a specific, already-known identity. Two people then edit one diagram
at once, each seeing the other's cursor, selection, and operations live. `DiagramSession` becomes
bidirectional, and the whole-graph autosave is replaced by granular operations — the same vocabulary
the MCP tools already speak, so human and agent writes converge onto one code path.

Products added: none.

### Layer 4 — AI assistance (from `09D-ARCHITECT-AICHAT.md`)

Describe an architecture in plain language and watch it get built; or, inside the editor, ask the
assistant to change or explain the diagram. The conversation runs inside `DiagramSession`, so it
survives the user closing the tab mid-turn, and its changes broadcast to every collaborator exactly
like a human's. The assistant grounds its advice in current Cloudflare documentation through
Cloudflare's own public documentation MCP server.

Products added: Workers AI, AI Gateway.

## 5. The work to be done

The job is a **port**, not a rewrite. The existing implementation is 18,349 lines of working,
reviewed, bug-fixed application code across 104 files, including a 2,023-line stylesheet whose
design tokens carry documented WCAG contrast ratios. That is the asset. The work is to move it onto
this repository's tooling and re-layer its Worker, changing as little else as possible.

### 5.1 Why this is a port and not a rewrite

A first attempt at this re-implementation rebuilt the UI on a server-rendered framework and
re-authored the presentation layer from scratch instead of copying it. The result is worth
recording, because it is the reason this section is written the way it is:

- The stylesheet came out at 720 lines against the original's 2,023. The missing 1,300 lines were
  not dead weight — they were the gallery cards, the modal layout, the toolbar, and the responsive
  breakpoints.
- The brand orange was re-typed as `#f48120`. It is `#f6821f`.
- The font stack became `Inter, ui-sans-serif, …`, a face the demo never loaded, instead of the
  original's `system-ui, -apple-system, "Segoe UI", sans-serif`.
- Features already present in the source material went missing: real diagram thumbnails in the
  blueprint gallery, the category filters, the create-diagram modal's two-column layout.
- Local development served no CSS at all, so none of the above was visible without a deploy. The
  defects were found one at a time, by a human, against production.

Every one of those was a **re-authoring** defect. None would have occurred by copying the file. The
conclusion is the governing rule for this work:

> Port the presentation layer **verbatim**. Adapt data access to the new service API; do not
> restyle, re-lay-out, or re-derive anything that already exists. A visual difference from
> `architect.cfapps.uk` is a porting bug until proven otherwise.

This is also why the application framework is unchanged. The original's client-side path switch in
`App.tsx` is a deliberate design: the `/app*` boundary must be a real browser navigation so
Cloudflare Access can intercept it before any bundle runs. A server-rendered router adds nothing the
editor needs — React Flow mounts client-only in any case — while putting the entire ported UI
through a framework migration at the same time as a tooling migration. One migration at a time.

### 5.2 What changes: tooling and control plane

- **No `wrangler.jsonc.tpl`, and no Wrangler.** `cloudflare.config.ts` is the single typed
  configuration source, resolving production resource IDs through `requireTerraformOutputs` and a
  committed placeholder fixture locally. This retires two workarounds the Wrangler version needed:
  the `generate-wrangler` templating step, and the observability-mirroring duplication that kept the
  same settings in lockstep across Terraform and the template by hand (source DECISIONS #24 and
  #25).
- **pnpm workspace, Oxfmt, and type-aware Oxlint** replace npm and Biome. Formatting policy comes
  from the repository-root `oxfmt.config.ts`; lint rules extend the root `oxlint.base.ts`.
- **D1 migrations run through the repository-root helper** (`scripts/d1-migrate.ts`), not
  `wrangler d1 migrations apply`.
- **One repository-root `.env`**, read by Terraform through the dotenv provider.
- **`@demos/worker-common` and `@adrianhall/cloudflare-toolkit`** replace the hand-rolled Access
  middleware, body-limit, JSON-body reader, identity accessor, and `/api/me` router.

### 5.3 What changes: the Worker's internal layering

The source groups the Worker by feature — `diagrams/{repository,types,validation}.ts`, `shares/…`,
`users/…`, `collaborators/…`. Each becomes four tiers, with dependencies pointing one way only:

| Source                                         | Tier                 | Destination                                       |
| ---------------------------------------------- | -------------------- | ------------------------------------------------- |
| `diagrams/validation.ts`, `graph-mutations.ts` | `domain/`            | Pure validation and graph operations, no bindings |
| (inline in route handlers)                     | `application/`       | Use cases, owning every authorization decision    |
| `diagrams/types.ts`                            | `application/ports/` | Repository interfaces                             |
| `diagrams/repository.ts` (D1 row types inline) | `infrastructure/`    | D1/KV adapters implementing those ports           |
| `routes/*.ts`                                  | `routes/`            | Thin HTTP shaping only                            |

Three consequences are load-bearing:

- **The source's repositories import D1 row shapes directly and have no port interface.** This is
  the one place the port's architecture is genuinely better than its source, and it is the reason
  the four-tier rule exists: the MCP tool layer (Layer 2) must call the _same_ use cases the HTTP
  API calls, in-process. A repository behind a port makes that a function call; a repository wired
  into route handlers makes it an internal HTTP round trip.
- **Route handlers stop constructing repositories.** Composition happens once, in a composition
  root, and the services are injected into request handling.
- **The repository port stays authorization-neutral.** Ownership decisions live in the application
  services, which keeps the uniform non-enumerating `404` the source relies on from leaking into
  storage code.

### 5.4 What changes: a small number of corrections

Carried forward from the source's own findings rather than re-discovered:

- **The verified identity reaches the Durable Object in a scrubbed request header**, not a query
  parameter. Any inbound copy is deleted before the verified value is set, in one named function,
  and that is tested — including a differently-cased spelling, since header names are
  case-insensitive.
- **`elkjs` does not run inside `workerd`.** The source proved this the hard way (Phase 11 spike):
  `new ELK()` throws synchronously from every entry point. The browser keeps ELK via a lazy
  `import()`; the server-side `autoLayout()` is a deterministic grid placement, and the MCP tool
  description must say so plainly.
- **Every `/api/*` Access policy entry sets `redirect: false` explicitly** (source DECISIONS #23).
  Without it, an API caller sending `Accept: text/html` is redirected to a login page instead of
  receiving JSON — and a `WebSocket` constructor cannot follow such a redirect at all.
- **`light-dark()` must survive the build.** Vite's CSS minifier lowers it into an
  OS-media-query-only polyfill, which silently breaks the in-app theme override in production while
  working perfectly in development. Both `css.transformer` and `build.cssMinify` need pinning, and
  the assertion belongs against **built** output — the source artifact looks correct either way.

### 5.5 What does not change

Everything else. Specifically, and verbatim wherever the file can simply be copied:

- `app.css` in full, including the `--cf-*` token names and the contrast-ratio comments that justify
  each value.
- The catalog (42 products, vendored official icons), the 8 blueprints, and the node/edge visual
  model. (The 8 blueprints are the porting floor, not a ceiling: Phase 10 of
  [`02-implementation.md`](./02-implementation.md) adds 14 more so the gallery covers every
  published Developer Platform reference architecture. That is new scope layered on top of a
  faithful port, not a change to what is being ported.)
- Every client component: `AppHeader`, `DarkModeToggle`, `ProductIcon`, `CFNode`, `CFEdge`,
  `ServicePalette`, `PropertiesPanel`, `DetailsPanel`, `Toolbar` and its controls,
  `BlueprintGallery`, `BlueprintPreview`, `CreateDiagramModal`, `DiagramGrid`, `DiagramCard`, the
  admin tables, and the Zustand store shape.
- The client hooks (`useModalFocus`, `useDismissableMenu`, `useIdentity`, `useDiagramLiveSync`) and
  pure libraries (`export.ts`, `scaffold.ts`, `theme.ts`, `datetime.ts`, `auto-layout.ts`,
  preference modules).
- The D1 schema, including the comments explaining why `users` has no `is_admin` column and why
  there are no foreign keys.
- The 35 fixed bugs. These are **not** re-litigated: each one's fix is already in the code being
  copied, and each becomes a regression test in [`01-specification.md`](./01-specification.md) so
  the port cannot silently undo it. Bugs 9–21, 25, 28–33 and 35 are specifically CSS and markup
  fixes that a re-authored stylesheet would lose.

### 5.6 How the port is verified

Re-authoring defects are invisible to unit tests — jsdom applies no stylesheets and has no font
metrics, so a missing 1,300 lines of CSS passes every DOM assertion. The port therefore needs checks
that a test suite can actually fail on:

- **Local development must render the real stylesheet.** This is a precondition for the work, not a
  nicety. Without it, visual verification costs a deploy and a human.
- **A fidelity contract test** asserts the brand hex, the font stack, and the presence of every
  `--cf-*` token in the **built** stylesheet, so drift fails `pnpm check` instead of reaching a
  reviewer.
- **A side-by-side review against `architect.cfapps.uk`** at each phase boundary, since that
  deployment is the reference for what "correct" looks like.

## 6. Placement

`cf-terraform-demos/architect`, deployed to `cf-architect.cfapps.uk`.

The hostname and the Worker name must both be editable. The current implementation is deployed as
`architect.cfapps.uk` and must keep running until the new codebase is verified, so the two
deployments coexist. Declare `hostname` and `worker_name` as Terraform variables and carry those
values throughout the new codebase — configuration, scripts, Access resources, tests, and docs — so
the application can be renamed at the appropriate time by changing the variables alone. See
[specification §1.3](./01-specification.md#13-naming-and-coexistence-with-the-source-deployment) for
the contract and the cutover steps.

The `cf` + Terraform family is the correct home: this demo needs Terraform-owned Access
applications, a custom hostname, D1, KV, and later a Durable Object namespace — infrastructure a
framework deployment pipeline cannot provision and tear down completely. The family's existing
layout (`src/client/{components,views,stores}` plus
`src/worker/{application,domain,infrastructure,middleware,routes}`) already matches the source's
client structure and this document's target Worker structure, so the port fits the convention rather
than bending it.

Architect will be the family's **first React demo**; every sibling is Vue. This is a forced,
documented exception: `@xyflow/react` is React-only and is the diagram engine the entire editor is
built on. Per the repository's scenario-override clause, translating a working React diagram editor
into Vue would be pure translation effort with no teaching value — and this demo's lesson is the
Cloudflare platform underneath, not the view layer.

## 7. Deliverables

- [`01-specification.md`](./01-specification.md) — the engineering specification: placement, tiers,
  data model, API surface, protocols, infrastructure ownership, the port inventory, and the quality
  bar.
- [`02-implementation.md`](./02-implementation.md) — the phased implementation plan, with each
  phase's deliverables, tests, and exit criteria.
