# Architect — Engineering Specification

## 1. Implementation decision

Build Architect at **`vinext-demos/architect`** as a **Vinext App Router** application using React,
TypeScript, Hono, Cloudflare Workers, Cloudflare Access, D1, Workers KV, Durable Objects, Workers
AI, AI Gateway, Terraform, `cf`, and `@demos/worker-common`.

React is an intentional and documented exception to the repository's Vue default. The product's
central interaction is an `@xyflow/react` canvas; retaining React avoids translating a mature,
proven implementation into another component model merely to rebuild the same UI. Vinext is still
the application host: it provides the route structure, server components, and Cloudflare Worker
integration required by the new repository.

| Requirement                 | Decision                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rich diagram canvas         | React 19 with `@xyflow/react`, React Testing Library, and Zustand for local editor state.                                                                                                    |
| New repository target       | Vinext App Router, `app/` pages and `app/api/**/route.ts` delivery adapters.                                                                                                                 |
| Code deployment             | `cf dev`, `vite build`, `cf deploy --prebuilt`; no Wrangler command, dependency, config, or template.                                                                                        |
| Infrastructure lifecycle    | Terraform owns Worker registration/bootstrap, custom hostname, D1, KV, Access, and AI Gateway. `cf` owns uploaded Worker code and the Durable Object namespace declared from its entrypoint. |
| Access and errors           | `createAccessMiddleware`, `currentIdentity*`, `createMeRouter`, `jsonBodyLimit`, `readJsonBody`, and problem-detail/logging helpers from shared libraries.                                   |
| Persistent diagram state    | D1 is the single durable source of truth; Durable Object state is ephemeral coordination/cache only.                                                                                         |
| Read-only anonymous sharing | D1 plus KV keyed only by a SHA-256 digest of a high-entropy token.                                                                                                                           |
| Live coordination           | One SQLite-class Durable Object, `DiagramSession`, named from a diagram id and using hibernatable WebSockets.                                                                                |
| AI model access             | Workers AI binding, with every inference call routed through the Terraform-created named AI Gateway.                                                                                         |

The browser never receives Cloudflare credentials, calls a Cloudflare binding, contacts an AI
provider, or talks directly to the documentation MCP server.

## 2. Product boundary

### 2.1 Included capability layers

This specification covers all four source layers, in dependency order:

1. **Editor:** catalog, blueprints, dashboard, single-editor canvas, autosave, sharing, admin,
   export, print, and theme.
2. **MCP:** a remote, Access Managed-OAuth-protected MCP server and server-to-browser agent live
   sync.
3. **Collaboration:** owner-managed edit collaborators, granular operations, presence, and cursors.
4. **AI assistance:** diagram generation and editor chat through Workers AI, AI Gateway, and the
   public Cloudflare documentation MCP server.

They are one deployed application and one hostname, not four demos or a microservice suite. The
implementation plan makes every layer a separately shippable boundary.

### 2.2 Explicit non-goals

- Pixel-level reproduction of the old Astro/React SPA; behaviour, safety properties, and learning
  goals are the parity target.
- Roles beyond one operator-configured administrator and an owner/editor collaborator distinction.
- An invite email flow, authenticated view-only collaborators, per-node ACLs, locks, or character-
  level collaborative text editing.
- CRDTs or operational transform. Node/edge operations are atomic; the serialized Durable Object
  order is the conflict policy.
- Server-side raster export or a browser-rendering product solely for MCP export.
- Persistent, listable, or reopenable AI chat transcripts.
- A Workflow. A bounded AI turn has no multi-day duration, human pause, or retry requirement;
  `DiagramSession` already supplies the serialization and connection independence needed here.

## 3. Product requirements

### 3.1 Routes and user-facing surfaces

| Route                | Access                        | Purpose                                                                                                                                   |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                  | Public                        | Landing page explaining Architect and linking to the authenticated dashboard.                                                             |
| `/blueprints`        | Public                        | Blueprint gallery and Generate with AI entry point. An anonymous visitor may browse templates but must sign in before creating a diagram. |
| `/app`               | Authenticated                 | Personal dashboard: owned diagrams, shared-with-me diagrams, create controls, identity, admin link when applicable, and logout.           |
| `/app/diagrams/[id]` | Authenticated                 | Editable diagram for an owner or collaborator.                                                                                            |
| `/app/admin`         | Authenticated + `ADMIN_EMAIL` | User directory and diagram moderation.                                                                                                    |
| `/s/[token]`         | Public                        | Anonymous, read-only live-pointer view of a valid share.                                                                                  |
| `/api/**`            | As defined below              | Same-origin, task-specific JSON and WebSocket API.                                                                                        |
| `/mcp`               | Authenticated, OAuth-capable  | Streamable HTTP MCP endpoint.                                                                                                             |

Page routes use Vinext server components by default. Interactive surfaces — the canvas, dashboard
controls, dialogs, local preference controls, and AI/chat WebSocket client — are focused
`'use client'` components under `src/ui/`. Server components and route handlers must not import
browser state modules.

### 3.2 Editor and catalog

Port the reviewed catalog data and blueprints, not their old component implementation:

- 42 Cloudflare product node types across Compute, Storage & Data, AI, Media, Networking & Security,
  and External / Generic categories; retain stable type IDs so saved diagrams remain compatible.
- Vendored, byte-identical official Cloudflare SVG product icons rendered inline using
  `currentColor`; generic external nodes use a small reviewed icon set instead.
- Eight blueprints: API Gateway, Full-Stack Web App, AI RAG Pipeline, Event-Driven Processing,
  Real-Time Collaboration, Multi-Tenant SaaS, Media Processing Pipeline, and Backend for Frontend.
- Four connection types: `data-flow`, `service-binding`, `trigger`, and `external`, with distinct
  labels, styles, and semantics. Animated data-flow edges respect `prefers-reduced-motion`.
- Palette search; persisted category-collapse preferences, initially Compute open and all other
  categories closed; click and drag alternatives for adding nodes.
- Product/edge property editing, documentation links, undo/redo, pan/zoom, minimap, fit-to-view,
  lazy-loaded ELK auto-layout, and a keyboard-operable **Connect nodes** dialog using native
  source/target/type selects. Pointer dragging can remain an enhancement, never the only way to
  connect nodes.
- A debounced persistence indicator with distinct saving, saved, offline/failure, and remote-update
  states. A diagram loaded into its editor fits its rendered viewport; a valid graph must never
  appear off-canvas because an ancestor has an indefinite height.

### 3.3 Dashboard, sharing, export, preferences, and admin

Authenticated users can create, rename, open, duplicate, and delete their own diagrams. Cards have
an accessible title, relative `time` metadata with an accessible absolute equivalent, and a
non-interactive React Flow thumbnail that cannot steal focus or pointer events from the card link. A
collaborator sees a separate **Shared with me** section annotated with the owner.

Sharing is anonymous, read-only, and live-pointer:

- An owner creates or rotates one active link and sees its raw URL exactly once.
- The raw token is generated with `crypto.getRandomValues`, sent only in that creation response, and
  never stored, logged, returned again, or placed in a D1/KV value.
- Store only `SHA-256(token)` as `diagram_shares.token_digest` and as the KV key. The KV value is
  the diagram id; a KV miss falls back to D1 and backfills KV because KV is eventually consistent.
- A share renders current diagram graph data at read time. Revocation sets `revoked_at` and removes
  its KV key; it does not leak whether a different token ever existed.
- The public response excludes owner, collaborators, admin data, and mutation endpoints.

The client exports PNG and SVG from its rendered canvas and generates a ZIP scaffold from the graph.
The ZIP is an intentionally ordinary starter artifact and may use a hand-editable `wrangler.toml`;
it is not this demo's own deployment configuration. Print mode and theme preferences are client
only. An explicit dark/light/system preference updates `color-scheme`, persists safely in
`localStorage`, and must work in the production-minified CSS output, not merely in dev mode.

The sole `ADMIN_EMAIL` identity may list the lightweight user directory and view/delete any diagram
for moderation. Admin status is never read from D1 and every admin route independently checks the
verified email; `/api/me` only provides a UI hint.

## 4. Architecture and source layout

### 4.1 Four tiers

Dependencies point one way only:

```text
React UI → Vinext/Hono delivery adapters → application/domain → infrastructure
```

| Tier               | Owns                                                                                                               | Must not do                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| UI                 | rendering, browser interactions, Zustand editor/session state, local preferences, same-origin API/WebSocket client | import bindings, authorize itself, construct repositories, trust an actor supplied by a user |
| Delivery           | Vinext page/API route adapters, Hono routing, Access and same-origin middleware, response shaping                  | contain graph/business rules or construct adapters per handler                               |
| Application/domain | use cases, validation, graph operations, ports, schemas, access decisions, protocol contracts                      | import Hono, Vinext, Worker bindings, D1, KV, or a React component                           |
| Infrastructure     | raw-D1, KV, Durable Object, Workers AI, AI Gateway, public-docs MCP adapters and configuration                     | decide UI layout or eligibility rules                                                        |

`src/worker/index.ts` is the one composition root permitted to depend on all server tiers. It reads
bindings, constructs adapters, injects services into request context, mounts middleware, and mounts
routes. Neither a route handler nor a Durable Object reconstructs repositories or application
services ad hoc.

### 4.2 Required layout

```text
vinext-demos/architect/
├── app/
│   ├── page.tsx
│   ├── blueprints/page.tsx
│   ├── app/page.tsx
│   ├── app/admin/page.tsx
│   ├── app/diagrams/[id]/page.tsx
│   ├── s/[token]/page.tsx
│   └── api/
│       ├── me/route.ts
│       ├── diagrams/[[...segments]]/route.ts
│       ├── shares/[[...segments]]/route.ts
│       ├── admin/[[...segments]]/route.ts
│       └── mcp/route.ts
├── src/
│   ├── access-policies.ts
│   ├── shared/                         # catalog, blueprints, graph/protocol types; no Worker/UI imports
│   ├── ui/                             # client components, hooks, stores, API client, styles
│   ├── worker/
│   │   ├── index.ts                    # Hono composition root
│   │   ├── bindings.ts
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── application/
│   │   │   ├── ports/
│   │   │   ├── diagrams/
│   │   │   ├── shares/
│   │   │   ├── collaboration/
│   │   │   ├── mcp/
│   │   │   └── ai/
│   │   ├── domain/
│   │   │   ├── diagrams/
│   │   │   ├── graph/
│   │   │   ├── shares/
│   │   │   ├── collaborators/
│   │   │   └── protocol/
│   │   └── infrastructure/
│   │       ├── d1/
│   │       ├── kv/
│   │       ├── durable-objects/
│   │       ├── mcp/
│   │       └── ai/
│   └── worker-entry.ts
├── migrations/
├── infra/
├── tests/{client,worker,integration}/
├── cloudflare.config.ts
├── vite.config.ts
└── README.md
```

`src/shared/` is deliberately narrow. It can hold data and serializable contracts required by both
runtime sides, such as `GraphData`, product catalog types, and WebSocket discriminated unions; it
must not become a backdoor through which Worker code imports UI or the UI imports infrastructure.

### 4.3 Durable Object Worker entrypoint

`src/worker-entry.ts` is the `cf` entrypoint. It re-exports Vinext's App Router handler and exports
`DiagramSession`, declared through `exports.durableObject({ storage: 'sqlite' })` in
`cloudflare.config.ts`.

Until Vinext preserves `101 Switching Protocols` responses, the entrypoint dispatches **only**
requests whose `Upgrade` header is `websocket` to the Hono application before delegating all other
requests to Vinext. The exception is protocol-keyed, not path-keyed: a plain request to the live
route reaches normal routing and receives `426 Upgrade Required`; the bypass never weakens Access.

## 5. Data, authorization, and HTTP contracts

### 5.1 D1 data model

Migrations are plain SQL in `migrations/`, run only through the repository helper scripts.

| Table                   | Required fields and purpose                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagrams`              | `id`, `owner_email`, `title`, `description`, `graph_data`, `created_at`, `updated_at`; one durable graph document.                          |
| `users`                 | `email` primary key, `display_name`, `first_seen_at`, `last_seen_at`; directory only, upserted from verified identity, never authorization. |
| `diagram_shares`        | digest primary key, diagram id, created/revoked timestamps; raw token is absent.                                                            |
| `diagram_collaborators` | diagram id, collaborator email, added-by email, added timestamp; primary key `(diagram_id, collaborator_email)`.                            |

D1 constraints/indexes cover owner list ordering, share lookup, and collaborator reverse lookup.
Repository methods return `null` for absent or inaccessible diagrams; delivery code maps that to a
non-enumerating `404`, not a `403` that proves another identity's id exists.

### 5.2 Access model

Terraform creates two self-hosted Access applications on `architect.<CLOUDFLARE_DOMAIN>`:

1. **Public bypass:** hostname-wide, allowing `/`, `/blueprints`, `/s/*`, and assets.
2. **Authenticated allow:** more-specific destinations for `/app*`, `/api/me*`, `/api/diagrams*`,
   `/api/admin*`, and `/mcp*`; any identity accepted by the team's configured identity provider may
   authenticate. Its `domain` must exactly equal one of its destination URIs.

Managed OAuth and dynamic client registration are enabled on the authenticated application for
`/mcp`. Support loopback callbacks (`127.0.0.1` and `localhost`) required by desktop MCP clients;
re-confirm current Access OAuth/DCR schema during implementation.

`buildAccessPolicies(audience)` is the one ordered list used by `cloudflareAccessPlugin()` and
`createAccessMiddleware({ buildPolicies, enableDevTokens: import.meta.env.DEV })`. It includes
explicit public `/`, `/blueprints`, `/s/*`, and `/_next/*` entries; `redirect: false` for API, MCP,
and WebSocket paths; and `redirect: true` for authenticated documents. The Worker validates a JWT's
signature, expiry, and the authenticated application's audience — JWKS sharing across a team makes
the audience check mandatory.

Every state-changing HTTP request additionally requires exact JSON content type and same-origin
`Origin`/`Sec-Fetch-Site` validation. The WebSocket route is authenticated before forwarding the
upgrade. The durable object trusts the verified identity only because no client reaches it directly.

### 5.3 API surface

All errors use RFC 9457 `application/problem+json` and never expose stack traces, token values,
graph contents, model responses, or upstream error internals.

| Route                                                      | Authorization                | Contract                                                                                |
| ---------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/me`                                              | authenticated                | `createMeRouter()` response extended with server-calculated `isAdmin`.                  |
| `GET/POST /api/diagrams`                                   | authenticated                | List owned diagrams; create blank or blueprint-seeded diagram.                          |
| `GET/PATCH/DELETE /api/diagrams/:id`                       | owner (GET may collaborator) | Read accessible diagram; owner-only metadata update and delete.                         |
| `PUT /api/diagrams/:id/graph`                              | owner or collaborator        | Fallback whole-graph replacement routed into `DiagramSession.applyWholeGraphReplace()`. |
| `GET/POST/DELETE /api/diagrams/:id/share`                  | owner                        | Status, create/rotate, revoke anonymous link.                                           |
| `GET /api/diagrams/:id/live`                               | owner or collaborator        | WebSocket upgrade; non-upgrade receives `426`.                                          |
| `GET/POST/DELETE /api/diagrams/:id/collaborators[/:email]` | as applicable                | List accessible collaborators; owner adds/removes; collaborator may remove self.        |
| `GET /api/diagrams/shared-with-me`                         | authenticated                | Diagrams where caller is editor but not owner.                                          |
| `GET /api/shares/:token`                                   | public                       | Resolve a valid token to safe read-only diagram fields.                                 |
| `GET /api/admin/users`                                     | administrator                | Paginated user directory and diagram count.                                             |
| `GET/DELETE /api/admin/diagrams/:id`                       | administrator                | Safe moderation projection and deletion.                                                |
| `POST /mcp`                                                | authenticated OAuth identity | Streamable HTTP MCP server.                                                             |

Routes adapt a request into a use case. They must neither create a D1/KV adapter nor parse graph
rules themselves. Use `jsonBodyLimit()` before JSON parsing and `readJsonBody()` for parsing.

### 5.4 MCP contract

The remote MCP server is stateless and uses the current Agents/MCP SDK Streamable HTTP handler.
Every tool derives the actor from Access middleware, invokes application services in-process, and is
scoped to diagrams accessible to that actor. It never internally calls this app's HTTP routes.

Required tools: `list_diagrams`, `get_diagram` (also resource `architect://diagrams/{id}`),
`create_diagram`, `rename_diagram`, `delete_diagram`, `add_node`, `update_node`, `remove_node`,
`add_edge`, `update_edge`, `remove_edge`, `auto_layout_diagram`, `create_share_link`,
`get_share_status`, `revoke_share_link`, and `export_diagram` (`json` or scaffold ZIP). Tool schemas
describe every argument and make ownership scope explicit. Raster export is browser-only.

The MCP auto-layout uses a deterministic, documented grid fallback rather than ELK: re-confirm the
existing workerd incompatibility before implementation. It must never claim to reproduce the
browser's layered ELK layout.

## 6. Live session and collaboration protocol

### 6.1 Upgrade identity and hibernation

The Worker checks ownership/collaboration **before** forwarding an upgrade to
`env.DIAGRAM_SESSIONS.getByName(diagramId).fetch()`. It calls one named
`withVerifiedIdentity(request, email)` helper that deletes the identity header case-insensitively,
then sets exactly the verified identity value. The object accepts with `ctx.acceptWebSocket()`, uses
`serializeAttachment()` to pin the author to the socket, and never accepts an author/email from a
client frame.

Socket attachment and D1/object storage are the only state available after hibernation. Instance
fields are disposable caches and must be hydrated before use.

### 6.2 Graph authority and operations

`DiagramSession` is one instance per `diagramId`. It retains no durable graph in its SQLite storage.
On cold start it reads D1 once through `blockConcurrencyWhile()`, keeps an in-memory graph and a
monotonic sequence, applies each operation synchronously, broadcasts it, then persists through one
serialized write chain. Every delayed write reads the newest in-memory graph when it executes, so a
slower earlier write cannot overwrite a later operation.

The discriminated operation union contains `addNode`, `updateNode`, `removeNode`, `addEdge`,
`updateEdge`, `removeEdge`, and controlled whole-graph replacement. Domain validation verifies type
IDs, edge type IDs, target existence, shape, duplicate semantics, and cascade removal. An invalid or
stale operation becomes an `operation_rejected` frame, not an unhandled socket failure.

The conflict model is explicitly last-operation-wins at node/edge field granularity. It is not a
CRDT and does not merge simultaneous text edits. D1 remains correct after eviction because it is the
one durable authority.

### 6.3 Frames and origins

Define one shared, exhaustive discriminated union for browser/object frames. At minimum:

- browser → object: `operation`, `cursor_moved`, `selection_changed`, `chat_message`;
- object → browser: `graph_snapshot`, `operation_applied`, `operation_rejected`,
  `presence_snapshot`, `presence_joined`, `presence_left`, `cursor_moved`, `selection_changed`,
  `chat_status`, `chat_token`, `chat_tool_result`, `chat_done`, `chat_error`, and `diagram_renamed`.

Each persisted mutation records origin `human`, `agent`, or `ai-chat`. A sender's own `clientOpId`
allows optimistic reconciliation; other clients receive the same operation. Cursor and selection
frames are ephemeral: they must never cause a D1 write. MCP mutations and HTTP fallback writes use
the same `DiagramSession` application port as human operations.

## 7. AI assistant and gateway policy

### 7.1 Mandatory gateway invariant

Every Workers AI call lives in one infrastructure client and supplies the named Terraform-created AI
Gateway id. No other production module may reference `env.AI.run`. A static architecture test proves
it. The client includes `gateway: { id }`, a bounded tool-round policy, and content-safe structured
logging. There is no direct-inference fallback, UI switch, or implicit default gateway.

The selected model is one operator-visible static Worker setting, not a browser choice. Before
implementation, confirm the live model id, tool-call wire shape, gateway compatibility, and a
fallback against current documentation and a controlled real-account spike. AI Gateway has explicit
Terraform configuration for logs, retention/privacy, caching, rate limits, and a presenter-safe
spend limit. Do not hard-code costs in UI; the dashboard is the operator surface for actual gateway
cost/log details.

### 7.2 AI chat behaviour

`runDiagramChatTurn()` is an application service with injected inference, documentation lookup, and
mutation callbacks; it does not import a Durable Object. `DiagramSession` supplies the callbacks and
keeps each connection's conversation ephemeral. Every model round carries the full tool list;
OpenAI-style streaming tool-call fragments are accumulated robustly, malformed/truncated arguments
are handled as recoverable tool errors rather than fatal turn failures, and reasoning-token fields
never reach the user.

The model sees a compact current catalog plus graph digest including stable node/edge IDs. It may:

- add/update/remove node or edge through the existing operation port;
- rename the diagram through the existing metadata use case; and
- search current Cloudflare documentation through an outbound, short-lived connection to
  `https://docs.mcp.cloudflare.com/mcp`.

The docs lookup is non-fatal, time-bounded, normalized to title/URL/snippet source data, and logs
only result count and latency. It never forwards a user prompt or raw response to logs. An AI turn
continues in the Durable Object if its originating WebSocket disconnects; reconnecting clients get
the persisted graph snapshot. This platform behaviour is a required spike, not an assumption.

## 8. Infrastructure, configuration, and lifecycle

### 8.1 Terraform ownership

Terraform owns the Worker registration, bootstrap Worker version/deployment, custom hostname, D1
database, `SHARES` KV namespace, the two Access applications/policies, and named AI Gateway.
`cloudflare_worker` has explicit `depends_on` edges to D1/KV, and bootstrap resources are ignored
after initial deployment. Terraform never uploads application code or creates a Durable Object
namespace.

Use `infra/providers.tf`, `infra/access.tf`, `infra/architect.tf`, and `infra/outputs.tf`. Read only
the root `.env` using the dotenv provider. Outputs are scalar, described, and mirrored by a typed
`infra/outputs.ts`; commit `infra/local-outputs.json`, ignore `infra/outputs.json` and all state.

### 8.2 `cloudflare.config.ts`

Use `defineConfig()`/`defineWorker()`, `requireTerraformOutputs`, and a committed local output
fixture. In production read ignored `infra/outputs.json`; in local/test mode read the fixture. Bind
D1 by its output ID in both modes, KV by its output ID, `ACCESS_AUD`, team domain, `ADMIN_EMAIL`,
gateway id, model setting, AI binding, and the self-referential Durable Object namespace. Export
`DiagramSession` from `src/worker-entry.ts` and configure its SQLite storage.

Local D1 migrations use:

```json
{
  "migrate:local": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/local-outputs.json --local",
  "migrate:remote": "node ../../scripts/d1-migrate.ts --cwd . --outputs infra/outputs.json"
}
```

`start` runs local migrations before `cf dev --persist-to .cloudflare/state`. `deploy` applies
Terraform, writes outputs, runs remote migrations, builds, and runs `cf deploy --prebuilt`.
`teardown` deletes the Worker before Terraform destroys its dependencies.

## 9. Quality, security, accessibility, and inherited findings

### 9.1 Baseline requirements

- Strict TypeScript with unused-local/parameter and fallthrough checks; complete truthful JSDoc.
- `pnpm` only; exact/pre-release dependency pinning in line with siblings.
- Oxfmt, type-aware Oxlint, offline unit/client/Workers-runtime tests, and finite integration-test
  timeouts.
- Test all auth outcomes, audience rejection, same-origin enforcement, ownership isolation,
  collaborator scope, admin scope, digest-only sharing, and teardown ordering.
- Structured logs use request/run/diagram ids and safe event metadata only. Never log graph data,
  raw share token, prompt, model output, documentation query/response, or verified email unless a
  specifically documented retention surface requires it.

### 9.2 Non-negotiable accessibility and correctness requirements

These are inherited fixes, written as requirements so they are not rediscovered later:

- Every dialog traps focus, starts at a meaningful control, closes on Escape, restores opener focus,
  and uses a real labelled dialog. Menus dismiss on Escape and outside click.
- Every icon-only action has an accessible name, tooltip, visible focus, at least a 24×24 CSS pixel
  target, and correct light/dark contrast. Chrome links do not look like body links; prose links
  remain visibly distinguishable.
- Form controls and unselected nodes meet WCAG non-text 3:1 contrast; danger text is theme-aware.
  CSS uses `box-sizing: border-box` globally so 100%-wide inputs remain within their panels.
- Node creation and edge connection have keyboard alternatives; the canvas itself has visible focus.
  React Flow thumbnails are `aria-hidden`, non-focusable, and pointer-inert.
- Palette descriptions are visible text, not hover-only; sidebars become overlay drawers on narrow
  screens; generated media/text alternatives and semantic headings/landmarks remain present.
- Remote cursor/presence color never carries identity/status alone; labels/initials are available.
  Animated edges and other nonessential motion respect reduced-motion preference.
- The editor's full-height container has a definite height. Fit-to-view runs after nodes initialize
  and is verified in a real browser, not only with mocked canvas tests.
- Preserve native `light-dark()` in production CSS (exclude its transformation from Lightning CSS,
  or use an equivalently verified strategy) so an in-app theme override is not replaced by the OS
  preference during minification.
- Client state updates are race-safe under React batching/Strict Mode; resolve mutable refs before
  scheduling state updaters so streamed assistant bubbles cannot duplicate.

## 10. Scripts and definition of done

`package.json` defines `start`, `check`, `fix`, `deploy`, `teardown`, and `test`, composed from
individually runnable colon sub-scripts using `npm-run-all2`. `check` is read-only and runs type
generation freshness, TypeScript, Oxfmt check, type-aware Oxlint, Terraform fmt/validate, contract
checks, and architecture guards. `fix` alone writes generated types/configuration, formatting, lint
fixes, or Terraform formatting.

The complete demo is done only when:

1. `pnpm check` and `pnpm test` pass offline.
2. `pnpm start` works from a clean clone with only root `.env` configured.
3. `pnpm deploy`, manual browser/MCP smoke checks, then `pnpm teardown` leave no Worker, D1, KV,
   Access, hostname, AI Gateway, or Durable Object resources behind.
4. The README documents prerequisites, root `.env` permissions, D1 migration workflow, Access/OAuth
   posture, sharing trade-off, collaboration conflict policy, AI Gateway/privacy/cost posture,
   commands, and all deliberate scope boundaries.
5. Every capability layer has its required deployed reality check in the implementation plan.
