# Architect — A Cloudflare-centric Architecture Diagram Tool

## Overview

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
| Application framework    | Plain React SPA on Vite, client-side path switch     | Vinext App Router with real server-rendered routes                  |
| Package manager          | npm                                                  | pnpm workspace                                                      |
| Formatting and linting   | Biome                                                | Oxfmt and type-aware Oxlint                                         |
| Environment              | Per-demo `.env`                                      | Repository-root `.env`                                              |
| Shared Worker concerns   | Hand-rolled per demo                                 | `@demos/worker-common` and `@adrianhall/cloudflare-toolkit`         |
| Worker structure         | Feature folders (`diagrams/`, `shares/`, …)          | Four tiers (`routes` → `application` → `domain` → `infrastructure`) |

The product behaviour is a faithful port. The infrastructure, framework, and internal architecture
are not — they are rebuilt to this repository's conventions, and several of the existing
implementation's structural choices do not survive that move.

## Source material

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

## What this demo teaches

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

## Capability layers

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

## What the port deliberately changes

Some of the existing implementation's choices are artefacts of Wrangler, of a plain SPA, or of a
feature-folder layout, and they do not survive the move. Each of these is a deliberate change, not
an oversight:

- **No `wrangler.jsonc.tpl`.** `cloudflare.config.ts` is the single typed configuration source,
  reading Terraform outputs in production and a committed placeholder fixture locally. This also
  retires the observability-mirroring workaround the Wrangler version needed, where the same
  settings had to be duplicated in Terraform and the template and kept in lockstep by hand.
- **Real routes instead of a client-side path switch.** The existing client reads
  `window.location.pathname` once at render and picks a view. Vinext's App Router gives the editor a
  genuine `/app/diagrams/[id]` route with its id available as a route parameter, which resolves a
  problem the original port's Phase 0 spike explicitly flagged as unsolved.
- **Four tiers, not feature folders.** `diagrams/{repository,types,validation}.ts` becomes
  validation and graph operations in `domain/`, use cases in `application/`, and D1/KV adapters in
  `infrastructure/`. Route handlers stop constructing repositories.
- **The verified identity reaches the Durable Object in a scrubbed header, not a query parameter.**
  Any inbound copy is deleted before the verified value is set, in one named function, and that is
  tested — including a differently-cased spelling.
- **Accessibility is a requirement, not a later pass.** The 35 bugs the existing implementation
  accumulated are folded into [`01-specification.md`](./01-specification.md) as first-class
  requirements with tests, so this implementation is born correct rather than rediscovering each one
  against a deployed build.

## Deliverables

- [`01-specification.md`](./01-specification.md) — the engineering specification: placement, tiers,
  data model, API surface, protocols, infrastructure ownership, and the quality bar.
- [`02-implementation.md`](./02-implementation.md) — the phased implementation plan, with each
  phase's deliverables, tests, and exit criteria.
