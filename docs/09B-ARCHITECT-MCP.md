# Demo 9B: Architect MCP Server

Directory: `demos/architect` (extends [Demo 9](./09-ARCHITECT.md) — same demo, same domain, no
new deployable unit)

Domain: `architect.cfapps.uk` (unchanged)

Status: Draft implementation plan — no code exists yet. Requires
[Demo 9](./09-ARCHITECT.md)'s Phases 0–6 (catalog, editor, dashboard, sharing, admin, export)
already shipped; this document only adds an agent-facing surface on top of that finished
application. It does **not** revisit anything Demo 9 already decided (Access model, D1 schema,
sharing security, admin authorization) except where explicitly called out below.

Cloudflare products added by this follow-on: Durable Objects (one new, narrowly-scoped class) and
Cloudflare Access's Managed OAuth capability. No new D1 table, KV namespace, or other product is
required — every agent-facing tool reuses Demo 9's existing `DB`/`SHARES` bindings and repository
classes.

## Summary

This adds a standards-based way for an agent to operate on a signed-in user's diagrams, plus the
real-time channel that keeps an open browser editor in sync with whatever that agent does:

1. **A remote MCP server** at `POST /mcp` (Streamable HTTP transport, the
   [Model Context Protocol](https://modelcontextprotocol.io)'s network-facing mode) for an
   agentic harness that runs **outside** the browser — OpenCode is this document's running
   example, but any MCP-compliant client works identically. Authentication reuses this demo's
   **existing** Cloudflare Access self-hosted application and policy (`infra/access.tf`'s `app`
   resource) with Access's **Managed OAuth** capability turned on, so a non-browser OAuth 2.1
   client completes the same login, against the same identity provider, under the same policy,
   as a person opening `/app` in a browser. There is no second Access application, no separate
   allow-list of "MCP users," and no third-party OAuth provider — anyone who can sign in to the
   editor can sign in to the MCP server, and nobody else can.
2. **A live-sync channel** so that an editor tab the user already has open **visibly updates
   while they watch** as an MCP tool call changes it — this is the demo's central teaching moment
   (see [Demo Flow](#demo-flow-addition)) and the reason this document introduces one narrow,
   justified exception to this repository's usual reluctance to reach for a Durable Object
   (`docs/BACKLOG.md`'s curriculum principles): a small `DiagramSession` Durable Object, one
   instance per diagram, whose only job is to hold open WebSocket connections from every browser
   tab currently viewing that diagram and push the fresh graph to them the instant a remote-MCP
   tool call changes it. Its design is deliberately the same shape
   `docs/09-ARCHITECT.md`'s [Post-MVP collaboration
   work](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) will later extend for
   real multi-user editing — see [Live Sync Architecture](#live-sync-architecture).

Every MCP tool ends up calling the **same** shared, already-tested
`DiagramRepository`/`ShareRepository`/`generateScaffold()` code Demo 9's Hono API already uses.
This document adds one new service layer (pure graph-mutation functions, see
[Shared Graph Mutation Service](#shared-graph-mutation-service)) and one new persistence-adjacent
concern (the live-sync Durable Object); it does not fork or duplicate Demo 9's data-access layer.

**Not in scope: WebMCP.** An earlier draft of this document also specified bridging these same
tools into the browser's own `navigator.modelContext` (the emerging
[WebMCP](https://github.com/webmachinelearning/webmcp) standard) via Cloudflare's
`agents/experimental/webmcp` adapter, for a browser-integrated AI agent running in the same tab.
Both that adapter and the underlying browser API are explicitly experimental and unshipped as of
this writing (Cloudflare's own README: "this adapter **will break** between releases"; the
WebMCP explainer is a W3C WebMachineLearning Community Group **incubation**, not a shipped
cross-browser standard), so it has been cut from this plan rather than built against a moving
target. Nothing below depends on it. If WebMCP support matures to the point of being worth
revisiting, it would layer on top of the remote MCP server this document does build — the tool
implementations would be reused, not rewritten — but that is future work for its own,
separately-scoped document, not a placeholder carried here.

## Prerequisites

- `docs/09-ARCHITECT.md` implemented and deployed — this document assumes `DiagramRepository`,
  `ShareRepository`, `generateScaffold()`, `accessMiddleware`, `access-policies.ts`, and the
  `diagrams`/`users`/`diagram_shares` D1 tables already exist exactly as that document specifies.
- Re-verify every product surface named below before implementing, per this repository's
  standing rule that skills and prior docs bias toward retrieval over pre-trained knowledge —
  MCP server handler APIs on the Agents SDK are a fast-moving surface (see the
  `createMcpHandler`/`McpAgent` migration note under [Remote MCP Tool
  Catalog](#remote-mcp-tool-catalog)) and are the subject of [Phase 11](#phase-11---spike-tag-phase-11-mcp-spike)'s
  own dedicated research item, not something to take as settled from this document alone.
- Confirm the account's Cloudflare Terraform provider pin (`~> 5.22.0`, this repository's
  baseline) already exposes `oauth_configuration` on `cloudflare_zero_trust_access_application`
  — verified present at 5.22.0 while writing this document, but re-check against whatever pin is
  actually in use at implementation time.

## Goals

- Let a signed-in user ask OpenCode (or an equivalent external agentic harness) to create, edit,
  share, and download their own diagrams, authenticated exactly the same way the editor itself
  authenticates them.
- Make an external agent's edits **visible immediately** in an editor tab the user already has
  open, without a manual refresh — the specific experience this document exists to design well.
- Reuse Demo 9's Access application, D1 schema, and repository code untouched; add the smallest
  possible new surface area (one Durable Object class, one MCP handler) to satisfy the above.

## Non-Goals

- **Real-time multi-user collaboration** (two humans editing the same diagram concurrently with
  cursors/presence) — Demo 9 already deferred this to
  [Post-MVP](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) and this document
  does not revisit that call. The live-sync channel here is deliberately narrower: it exists so
  *one* owner's own agent and that same owner's own open tab agree, not so two different people
  can co-edit. Concurrent writes are resolved last-write-wins (see
  [Concurrency Model](#concurrency-model)), not merged.
- **Raster (PNG/SVG) export from the remote MCP server.** Demo 9's export already only exists as
  a client-side, DOM/canvas-based operation (`html-to-image` against the live React Flow canvas —
  see `src/client/lib/export.ts`); there is no server-side browser-rendering step in this demo
  (Browser Run is not a listed product). The remote MCP server's `export_diagram` tool returns
  structured data instead (the graph JSON, or the project scaffold ZIP — both pure data
  transforms with no DOM dependency); pixel-perfect raster export stays a browser-only action
  (the editor's existing toolbar button), not something an MCP-driven agent can request. This is
  a deliberate, documented capability gap, not an oversight — see the `export_diagram` tool in
  the [Remote MCP Tool Catalog](#remote-mcp-tool-catalog).
- **WebMCP** (`navigator.modelContext`) and any bridge into it (Cloudflare's
  `agents/experimental/webmcp`). See [Summary](#summary) — both the adapter and the underlying
  browser API are explicitly experimental and unshipped as of this writing, so this document does
  not build against either. Revisiting this is future work for its own document once (and if)
  either stabilizes.
- **A new Identity Provider, a new Access application, or a service-token/machine-identity auth
  path.** Every actor in this document (a human via the browser, that same human's OpenCode
  session) authenticates as that one verified Access identity — never as a separate machine
  principal. See [Access Model](#access-model).
- **Rewriting Demo 9's REST API.** `/api/diagrams/*` is untouched. MCP tools call the same
  repository/service functions **in-process** (function calls, not internal HTTP round-trips to
  the Worker's own API) — see [Shared Graph Mutation Service](#shared-graph-mutation-service).

## Access Model

Extends Demo 9's existing model (`docs/09-ARCHITECT.md`'s [Access
Model](./09-ARCHITECT.md#access-model)) rather than adding a new one:

- Add `/mcp*` as a fourth destination on the **existing** `cloudflare_zero_trust_access_application.app`
  resource in `infra/access.tf`, alongside its current `/app*`, `/api/me`, `/api/diagrams*`, and
  `/api/admin*` entries. It is still backed by the same `authenticated_users` policy (`decision =
  "allow"`, `include = [{ everyone = {} }]` — "everyone" here means every identity the account's
  already-configured IdP(s) can authenticate, per Demo 9's Decisions #2, not literally anyone
  unauthenticated). **No new Access application, and no new policy.**
- Enable [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
  on that same `app` Access application via its `oauth_configuration` block (present on
  `cloudflare_zero_trust_access_application` at this repository's pinned provider version — see
  [Prerequisites](#prerequisites)):

  ```hcl
  resource "cloudflare_zero_trust_access_application" "app" {
    # ...unchanged domain/destinations/policies from docs/09-ARCHITECT.md, plus /mcp* below...

    destinations = [
      # ...existing /app*, /api/me, /api/diagrams*, /api/admin* entries, unchanged...
      {
        type = "public"
        uri  = "${local.hostname}/mcp*"
      }
    ]

    # Turns Access itself into the OAuth 2.1 authorization server a non-browser MCP client (like
    # OpenCode) needs. Without this, a client that cannot complete a browser login redirect gets
    # an un-completable 302 -- see docs/09B-ARCHITECT-MCP.md's Access Model.
    oauth_configuration = {
      enabled = true
      dynamic_client_registration = {
        enabled                = true
        allow_any_on_loopback  = true # OpenCode's MCP OAuth client listens on 127.0.0.1 for the redirect
        allow_any_on_localhost = true
        # DCR, not the newer Client ID Metadata Documents (CIMD) mechanism the MCP 2026-07-28 spec
        # now prefers. This is not a client-readiness tradeoff (Claude Code has already migrated
        # to CIMD in production; OpenCode has not, per Phase 11 / spikes/07-architect-mcp-spike/
        # REPORT.md) -- it is a hard platform ceiling: Cloudflare Access's own oauth_configuration
        # (confirmed against the pinned provider schema and the live API reference, both Beta) has
        # no CIMD field at all and never advertises client_id_metadata_document_supported, so per
        # the MCP spec's own client priority order, *every* client falls back to DCR against this
        # application regardless of its own CIMD support. Re-check whether Access has shipped CIMD
        # support if picking the demo back up well after DCR's summer-2027 removal target.
      }
      grant = {
        # Short-lived access token + long-lived refresh grant is Cloudflare's own recommended
        # shape for CLI/agent use cases: the client refreshes silently in the background and
        # Access re-evaluates policy on every refresh, so a revoked identity is cut off within
        # one token lifetime, not just at initial login.
        access_token_lifetime = "15m"
        session_duration      = "336h" # 14 days
      }
    }
  }
  ```

  **Confirmed in [Phase 11](#phase-11---spike-tag-phase-11-mcp-spike)**
  (`spikes/07-architect-mcp-spike/REPORT.md`): OpenCode's MCP OAuth client defaults to a fixed
  redirect, `http://127.0.0.1:19876/mcp/oauth/callback` (overridable via `opencode.json`'s
  `mcp.<name>.oauth.callbackPort`/`redirectUri`), and its local callback server binds literally to
  `127.0.0.1`. Narrowing to an explicit `allowed_uris` entry instead — this document's original
  suggestion — turns out not to be available for this client at all: Cloudflare's Managed OAuth
  `allowed_uris` field requires an `https://` URL, and OpenCode's loopback redirect is plain
  `http://` by design (OAuth 2.1's native-app loopback exception). `allow_any_on_loopback` is
  therefore not a broader fallback choice here, it is the **only** mechanism that can admit this
  client — keep both flags enabled as configured above.
- The Worker's `/mcp` route mounts the **same** `cloudflareAccess()` middleware instance
  `src/worker/index.ts` already uses for `/api/*`, with `/mcp` added to
  `src/access-policies.ts`'s policy array (`authenticate: true, redirect: false` — an MCP client
  is never a browser navigation, matching the existing `/api` entry's reasoning). No MCP-specific
  authentication code is written: Managed OAuth resolves a client's opaque bearer token into the
  same `Cf-Access-Jwt-Assertion` header server-side before the request ever reaches the Worker
  (per Cloudflare's own docs, "From your origin's perspective, the request looks the same as a
  browser-authenticated request") — `cloudflareAccess()` cannot tell, and does not need to tell,
  whether a request arrived via a browser cookie or via Managed OAuth.
- Every MCP tool handler derives the caller's identity from
  `context.get("Cloudflare_Access_Identity").email` (Hono context) exactly like every existing
  `diagramsRouter`/`sharesRouter` handler, and every repository call it makes is owner-scoped the
  same way — a tool cannot read or mutate a diagram it does not own, full stop, regardless of
  which client called it.
- `cloudflareAccessPlugin()` in `vite.config.ts` must add `/mcp` to its shared `accessPolicies`
  array (imported from `src/access-policies.ts`, per Demo 9's existing pattern) so local
  development gates it identically. A locally-issued dev JWT is sufficient for exercising `/mcp`
  in `vite dev`; Managed OAuth itself cannot be emulated locally (it is a real Access-edge
  feature) — [Phase 15](#phase-15---verification-tag-phase-15-verification)'s manual smoke check
  covers the real OAuth round-trip against the deployed hostname instead, the same way Demo 9's
  own Phase 0 report flagged real drag-and-drop as needing a manual check.

## Live Sync Architecture

### Why A Durable Object, Here Specifically

This repository's curriculum principles (`docs/BACKLOG.md`: "Do not use a Durable Object unless
the application needs coordination, strong consistency, or persistent connections") and
`docs/10-OPENCODE-BROWSER.md`'s own precedent — choosing D1 polling over a Durable Object for its
egress log precisely because polling was good enough there — both point the same direction here,
just to the opposite conclusion. A live WebSocket push to an open editor tab is the one case in
this add-on that is *not* "good enough" as polling: the entire point of this document's central
demo moment is that the canvas updates **the instant** an agent acts, not a few seconds later, and
"push the instant something changes to every currently-connected client" is a textbook persistent-
connection coordination problem, not a data-access problem.

### `DiagramSession` (one instance per diagram id)

A new, minimal Durable Object, `src/worker/diagram-session/diagram-session.ts`, re-exported from
`src/worker/index.ts` exactly like `demos/chat`'s `ChatRoom`:

- **Identity**: named by the diagram's own D1 primary key (`env.DIAGRAM_SESSIONS.idFromName(diagramId)`)
  — no separate mapping table, mirroring `demos/chat`'s room-by-name pattern.
- **State**: holds no durable data of its own. D1 remains the single source of truth for a
  diagram's graph; this object exists purely as a live fan-out point for browser connections
  currently open on that diagram. (`new_sqlite_classes` migration is still required by Wrangler
  for any Durable Object class, per the `durable-objects` skill, even though this class persists
  nothing meaningful to it.)
- **Connect**: the editor's `DiagramCanvas` opens a WebSocket when a diagram loads:
  `GET /api/diagrams/:id/live` (Upgrade request), owner-verified by the Worker **before**
  forwarding to the Durable Object (the same `findOwned(id, ownerEmail)` check every other
  diagram route performs) — the Durable Object itself never re-derives ownership, it only accepts
  connections the Worker already authorized, matching this repository's usual pattern of
  authorization living at the Worker/API boundary.
- **Accept**: uses the [WebSocket Hibernation
  API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (`ctx.acceptWebSocket()`),
  not a plain `WebSocket.accept()`, so an idle open editor tab does not keep billing the Durable
  Object while nothing is happening — consistent with `durable-objects` skill guidance and this
  repository's cost-consciousness elsewhere (Demo 9's own ELK lazy-load, Demo 10's `sleepAfter`).
- **Broadcast**: exposes one RPC method, `notifyGraphUpdated(graphData: string, updatedAt:
  string)`, called by the Worker (not the browser) immediately after any successful graph-
  mutating MCP tool call persists to D1 (see [Shared Graph Mutation
  Service](#shared-graph-mutation-service)). It sends `{ type: "graph_updated", graphData,
  updatedAt }` to every currently-accepted WebSocket for that instance.
- **Does not** accept writes from the browser side of the socket at all — this channel is
  strictly server→client push. The browser's own edits keep using the existing debounced `PUT
  /api/diagrams/:id/graph` autosave path (Demo 9, unchanged); this document adds a read channel,
  not a second write channel.

**Forward-compatibility, deliberate:** this identity/connection-lifecycle design (one instance per
diagram, Worker-side owner check ahead of the upgrade, hibernated accept, fan-out to every
connected socket) is intentionally the foundation `docs/09-ARCHITECT.md`'s
[Post-MVP live-collaboration work](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals)
extends later — a bidirectional channel, presence/cursor messages, and per-operation broadcast
built on top of this same class, not a second per-diagram Durable Object designed from scratch.
Nothing in this document's own MVP scope (single owner, single agent, read-only push) requires
building that extensibility now; it falls out of keeping this object's responsibilities narrow
rather than out of any speculative generality added here.

### Client Behavior On Receipt

`DiagramCanvas`'s WebSocket `onmessage` handler, on a `graph_updated` event whose `updatedAt` is
newer than the store's own last-known `updatedAt`, replaces the Zustand store's graph state with
the pushed one and re-renders the canvas — the same state-replacement the store already performs
after its own initial `GET /api/diagrams/:id` load, reused rather than duplicated. A brief,
dismissible toast ("Updated by an agent") is shown so the user understands *why* the canvas just
changed under them, rather than silently rewriting their screen with no explanation — this is the
one new piece of UI this document adds to the editor.

### Concurrency Model

This is explicitly last-write-wins, not a CRDT or an operational-transform merge, matching this
demo's existing autosave model (Demo 9 already has no partial-patch protocol — every autosave
replaces the whole graph). Two sequencing facts keep this acceptable for a single-owner-plus-
their-own-agent scenario (as opposed to the genuinely harder multi-human case Demo 9 already
deferred):

- If the user is mid-edit when an agent's change arrives, the push simply replaces their canvas;
  their own in-flight debounced autosave will fire shortly after and overwrite the agent's change
  right back — a brief visual "flicker" at worst, not data loss, since D1's own `updated_at`
  column always reflects whichever write actually landed last.
- If an agent's tool call and the browser's own autosave land on D1 in the same instant, D1's own
  `UPDATE ... WHERE id = ? AND owner_email = ?` (already how `saveGraphData()` works today) makes
  the last statement to commit win outright; there is no read-modify-write race across two
  different owners because every write is scoped to one owner already.

Document this plainly in `EXPLAIN-DEMO.md` as a deliberate scope boundary, not a limitation
discovered later — real concurrent-editor conflict resolution remains
[Post-MVP](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals).

## Shared Graph Mutation Service

A new `src/worker/diagrams/graph-mutations.ts` module of small, pure functions operating on the
already-defined `GraphData` shape (`src/worker/diagrams/types.ts`, unchanged) — reused by every
node/edge-level MCP tool, and unit-tested independently of any MCP or Durable Object plumbing:

| Function | Behavior |
| --- | --- |
| `addNode(graph, input)` | Appends a node `{ id: crypto.randomUUID(), type: "cf-node", position, data: { typeId, label, description } }` — `"cf-node"` is `src/client/components/editor/nodes/nodeTypes.ts`'s existing registry key, imported from a shared constant rather than re-typed as a string literal in two places. |
| `updateNode(graph, nodeId, patch)` | Merges `patch` into the matching node's `data` (and/or `position`); throws `notFound()` if `nodeId` does not exist. |
| `removeNode(graph, nodeId)` | Removes the node and cascades removal of every edge whose `source`/`target` references it — an orphaned edge is a worse failure mode than an over-eager cascade. |
| `addEdge(graph, input)` | Appends an edge `{ id: crypto.randomUUID(), type: "cf-edge", source, target, data: { edgeType, label, description, protocol } }` — `"cf-edge"` from `edgeTypes.ts`'s registry the same way. Validates both `source`/`target` reference existing node ids first. |
| `updateEdge(graph, edgeId, patch)` / `removeEdge(graph, edgeId)` | Symmetric to the node versions. |
| `autoLayout(graph)` | **Corrected in [Phase 11](#phase-11---spike-tag-phase-11-mcp-spike)** (`spikes/07-architect-mcp-spike/REPORT.md`): `elkjs` does **not** run inside `workerd` — `new ELK()` throws synchronously from every entry point and workaround attempted, root-caused to its bundled build re-`require`-ing a co-bundled file that resolves to no usable export once bundled a second time for `workerd`. This function therefore implements a deterministic **grid-placement** fallback instead (fixed-spacing rows/columns, ordered by a simple breadth-first traversal from the graph's edges) — not `elkjs`'s layered algorithm. `auto_layout_diagram`'s MCP tool description must say plainly that it produces a simpler grid arrangement than the editor's own auto-layout button, so a calling model does not over-promise the result to the user. |

Every MCP tool handler follows the same four-step shape: `findOwned()` the diagram → apply one
pure mutation function to its parsed `graphData` → `validateGraphDataInput()`-equivalent
re-canonicalization (reuse `src/worker/diagrams/validation.ts`'s existing helpers directly rather
than re-implementing shape validation) → `saveGraphData()` → `DiagramSession.notifyGraphUpdated()`.
No new REST endpoints are added for node/edge-level mutation — the browser client still always
autosaves the whole graph (Demo 9's existing, unchanged design); only the MCP tool layer needs
granular mutation, and it calls these functions directly, in-process, never through the Worker's
own HTTP API.

## Remote MCP Tool Catalog

Served from `POST /mcp` via `createMcpHandler` (`agents/mcp/server`, `@modelcontextprotocol/server`)
— the current, **stateless** handler API (per current Cloudflare Agents SDK docs: "`McpAgent` is
deprecated and feature-frozen"; do not build this with `McpAgent`). Stateless is also the correct
fit here on its own merits: no MCP protocol session needs to survive a request, since every tool's
actual state lives in D1, not in the MCP server itself.

| Tool | Input | Behavior |
| --- | --- | --- |
| `list_diagrams` | — | Caller's own diagrams (id, title, description, updatedAt), via `DiagramRepository.listOwned()`. |
| `get_diagram` | `diagramId` | Full metadata + parsed graph (nodes/edges/viewport) for one owned diagram. Also exposed as an MCP **resource** (`architect://diagrams/{id}`) so a client can attach it as read-only context without an explicit tool call, per MCP's own tools-vs-resources guidance. |
| `create_diagram` | `title?`, `description?`, `blueprintId?` | Delegates to `DiagramRepository.create()`, resolving `blueprintId` against `BLUEPRINT_MAP` exactly like `POST /api/diagrams` already does. |
| `rename_diagram` | `diagramId`, `title?`, `description?` | `DiagramRepository.updateMetadata()`. |
| `delete_diagram` | `diagramId` | `DiagramRepository.remove()`, cascading share revocation exactly like `DELETE /api/diagrams/:id`. |
| `add_node` / `update_node` / `remove_node` | `diagramId`, node fields | [Shared Graph Mutation Service](#shared-graph-mutation-service), then broadcast. |
| `add_edge` / `update_edge` / `remove_edge` | `diagramId`, edge fields | Same. |
| `auto_layout_diagram` | `diagramId` | Same, via `autoLayout()` (see spike note above). |
| `create_share_link` | `diagramId` | `ShareRepository.rotate()`, returns the one-time raw URL exactly like `POST /api/diagrams/:id/share`. |
| `get_share_status` | `diagramId` | `ShareRepository.getStatus()`. |
| `revoke_share_link` | `diagramId` | `ShareRepository.revokeActive()`. |
| `export_diagram` | `diagramId`, `format: "json" \| "scaffold"` | `"json"` returns the canonical `GraphData` as a text content block; `"scaffold"` calls the **exact same** `generateScaffold()` (`src/client/lib/scaffold.ts` — confirmed DOM-free, pure data transform) zipped with `fflate` server-side, returned as a base64 resource content block. An MCP-driven harness like OpenCode saves this to a local file itself; there is no server-hosted download URL. PNG/SVG are intentionally absent here — see [Non-Goals](#non-goals). |

Every tool's Zod `inputSchema` includes a `.describe()` on each field (per current MCP tool-design
guidance) and every tool's top-level `description` states its ownership scoping plainly (for
example: "Only ever lists diagrams owned by the authenticated caller") so a model calling it does
not need to guess the security model from behavior.

## Data Model

No new D1 table. One new Durable Object class (`DiagramSession`, no durable storage of its own —
see [Live Sync Architecture](#live-sync-architecture)). Every existing `diagrams`/`users`/
`diagram_shares` row shape from `docs/09-ARCHITECT.md` is unchanged.

Extend the existing structured log events (`diagram_created`, `diagram_updated`,
`diagram_shared`, `diagram_share_revoked` — already emitted by `src/worker/routes/diagrams.ts`)
with one additional field, `via: "api" | "mcp"`, threaded through from whichever caller performed
the mutation, so Workers Logs can distinguish an agent-driven change from a browser button click
without a new log event or a new table — see [Demo Flow](#demo-flow-addition) for where a
presenter shows this live.

## Infrastructure Changes

- `infra/access.tf`: extend the existing `app` Access application's `destinations` with `/mcp*`
  and add its `oauth_configuration` block — see [Access Model](#access-model). No new
  `cloudflare_zero_trust_access_application` or `cloudflare_zero_trust_access_policy` resource.
- `infra/architect.tf`: no changes. The `DiagramSession` Durable Object's binding and
  `new_sqlite_classes` migration are declared entirely in `wrangler.jsonc.tpl` and owned by
  Wrangler at deploy time — mirroring `demos/chat`'s `ChatRoom` pattern and
  `docs/10-OPENCODE-BROWSER.md`'s explicit precedent for why Durable Object namespaces are a
  Wrangler-owned concern in this repository, not a Terraform one. No `depends_on` is needed on
  `cloudflare_worker.demo` for it, for the same reason.
- `wrangler.jsonc.tpl`:
  - Add `durable_objects.bindings` (`{ "name": "DIAGRAM_SESSIONS", "class_name": "DiagramSession"
    }`) and a `migrations` entry (`{ "tag": "v1", "new_sqlite_classes": ["DiagramSession"] }`).
  - No change to `assets.run_worker_first` beyond confirming `/mcp` and `/api/diagrams/:id/live`
    both already fall under the existing `["/api/*"]`-style prefix once `/mcp` is added
    explicitly (`run_worker_first: ["/api/*", "/mcp*"]`) — `/mcp` is not under `/api/*` today and
    must be added as its own entry, or every MCP request falls through to the `ASSETS` SPA
    fallback and 404s.
- `package.json`: add `agents`, `@modelcontextprotocol/server`, and `zod` as Worker-side
  dependencies. No client-side dependency is added — there is no browser-facing tool surface in
  this document.

## Implementation Plan

### Phase 11 - Spike (tag: `phase-11-mcp-spike`)

**Status: research items 1–3 complete — see `spikes/07-architect-mcp-spike/REPORT.md` and
`docs/DECISIONS.md` #29.** Item 4's client-behavior research (redirect URI, DCR, PKCE, RFC 8707)
is also complete from the same report; its real-account, deployed end-to-end OAuth round trip is
the one piece intentionally left as a manual step before treating this phase as fully closed (see
that report's "Scope boundary" note) — this repository's standing rule against touching real
account infrastructure without explicit request applied here.

1. **Research the current Cloudflare-approved mechanism(s) for a stateless MCP server** before
   writing any server code — do not assume `createMcpHandler` (`agents/mcp/server`), the package
   this document specifies, is still Cloudflare's blessed path by implementation time; this whole
   area moved twice in the course of researching this document alone (`McpAgent` →
   `createMcpHandler`/`@modelcontextprotocol/server`) and should be assumed to move again. Cover,
   specifically:
   - **The Cloudflare blog** (`blog.cloudflare.com`) for the current or most recent MCP-server
     announcement post — these posts are historically where a protocol/package transition (for
     example the stateless-handler migration this document already had to absorb) is announced
     first, ahead of the reference docs catching up.
   - **`github.com/cloudflare`'s own repositories**, not just `cloudflare/agents` — at minimum
     check `cloudflare/ai` (the `demos/remote-mcp-*` examples this document's Access Model section
     already cites), `cloudflare/workers-oauth-provider`, and search the org for any repository
     with "mcp" in its name that did not exist, or looked different, when this document was
     written. A repository's own README and its `examples/`/`demos/` directories are more likely
     to reflect the *current* recommended shape than a cached understanding of the docs site.
   - **Every npm package published under the `@cloudflare` scope** that touches MCP (search
     `npmjs.com/org/cloudflare`, not just the specific package names already named in this
     document) — confirm `@modelcontextprotocol/server` (used by `createMcpHandler`) is still the
     right dependency, whether a first-party `@cloudflare/*`-scoped MCP package has since
     shipped that supersedes going through the community-namespaced
     `@modelcontextprotocol/server`/`@modelcontextprotocol/sdk` packages directly, and each
     candidate package's current version and changelog for anything that changes this document's
     `createMcpHandler`/`McpServer`/`registerTool` usage.

   Record the mechanism this research settles on — and a one-line justification citing which of
   the three sources above confirmed it — in `docs/DECISIONS.md` before Phase 12 starts. If the
   research surfaces a materially different approach than `createMcpHandler`, treat that as a
   scope change to this document, not a detail to quietly substitute in Phase 12.
2. Confirm `createMcpHandler` (`agents/mcp/server`) — or whichever mechanism item 1 above
   confirms is current — is still current against the latest Cloudflare Agents SDK docs.
3. Confirm `elkjs`'s layout algorithm runs unmodified inside `workerd` (no DOM, no `Worker`/WASM
   dependency it cannot satisfy). Record the finding — and the grid-placement fallback decision if
   it fails — in `docs/DECISIONS.md`.
4. Verify OpenCode's current MCP OAuth client redirect behavior against Access Managed OAuth
   end-to-end on a scratch Access application, before wiring the real one. **Client-behavior
   research (redirect URI, Dynamic Client Registration, PKCE, RFC 8707) is complete** — see the
   status note above. The live, deployed-account round trip itself is still outstanding; perform
   it before Phase 12's real `oauth_configuration` apply if it has not been done by then.

**Definition of done**: every open question above has a written answer in `docs/DECISIONS.md`,
including the confirmed (or corrected) stateless-MCP-server mechanism from item 1, and the
auto-layout fallback path (if needed) is chosen before Phase 13 starts. Met for items 1–3 and for
item 4's client-behavior research; item 4's live scratch-application round trip remains an
outstanding manual step (see above), to complete before or during Phase 12.

### Phase 12 - Remote MCP Server, Read And Metadata Tools (tag: `phase-12-mcp-server`)

1. Add `agents`, `@modelcontextprotocol/server`, and `zod`. Extend `infra/access.tf`'s `app`
   application's `destinations`/`oauth_configuration` (see [Access
   Model](#access-model)); apply and re-verify with `terraform plan`.
2. Add `/mcp` to `src/access-policies.ts` and `vite.config.ts`'s `cloudflareAccessPlugin()`
   policy array. Add `run_worker_first: ["/api/*", "/mcp*"]` to `wrangler.jsonc.tpl`.
3. Implement `src/worker/mcp/server.ts` (`createServer()` factory + `createMcpHandler()`, module
   scope per current guidance) and mount it at `POST /mcp` in `src/worker/index.ts`, behind
   `accessMiddleware`.
4. Implement `list_diagrams`, `get_diagram` (tool + `architect://diagrams/{id}` resource),
   `create_diagram`, `rename_diagram`, `delete_diagram` — every one a thin wrapper over the
   existing `DiagramRepository`, deriving `ownerEmail` from `getMcpAuthContext()`/the verified
   Access identity exactly like every existing route.
5. Emit `diagram_created`/`diagram_updated`/etc. structured logs with `via: "mcp"` from these
   handlers (see [Data Model](#data-model)).

**Testing**: worker-project unit tests for each tool handler against a fixture D1, Access
enforcement on `/mcp` (unauthenticated request → `401`; a different identity's diagram id →
"not found," never "forbidden," matching every existing diagram route's information-disclosure
posture).

**Definition of done**: OpenCode (or MCP Inspector, for a faster local loop) can list, create,
rename, and delete a diagram end to end against a deployed instance, authenticated via Managed
OAuth.

### Phase 13 - Graph Mutation Tools And Live Sync (tag: `phase-13-live-sync`)

6. Implement `src/worker/diagrams/graph-mutations.ts`'s pure functions (see [Shared Graph
   Mutation Service](#shared-graph-mutation-service)), unit-tested directly against fixture
   `GraphData` values with no D1, Worker, or MCP involvement.
7. Implement `src/worker/diagram-session/diagram-session.ts` (`DiagramSession` Durable Object):
   `fetch()` upgrade handling via `ctx.acceptWebSocket()`, the `notifyGraphUpdated()` RPC method,
   and `webSocketClose()`/`webSocketError()` cleanup. Re-export it from `src/worker/index.ts`.
   Add its `durable_objects`/`migrations` entries to `wrangler.jsonc.tpl`.
8. Add `GET /api/diagrams/:id/live` (WebSocket upgrade route): owner-checks via
   `DiagramRepository.findOwned()`, then forwards to
   `env.DIAGRAM_SESSIONS.idFromName(id)`/`.get(id)`/`.fetch(request)`.
9. Wire `add_node`/`update_node`/`remove_node`/`add_edge`/`update_edge`/`remove_edge`/
   `auto_layout_diagram` MCP tools: `findOwned()` → mutate → `validateGraphDataInput()`-equivalent
   canonicalization → `saveGraphData()` → `DiagramSession.notifyGraphUpdated()`.
10. Client: `DiagramCanvas` opens the `/api/diagrams/:id/live` WebSocket on mount, closes it on
    unmount, and replaces the Zustand graph state (plus the "Updated by an agent" toast) on a
    `graph_updated` message newer than the store's own `updatedAt`.

**Testing**: apply the `testing-durable-objects` skill's guidance directly — hibernatable
WebSocket tests via `runInDurableObject`, careful `evictAllDurableObjects()`/`deleteAll()`
sequencing in `afterEach`. Integration-test the full loop: open two simulated WebSocket
connections to the same diagram id, call a graph-mutating MCP tool, assert both receive the
`graph_updated` push with the new graph.

**Definition of done**: calling `add_node` via MCP against a diagram with an open, connected
WebSocket results in that connection receiving the update within the same test run — the
automated proxy for this document's central live-editing demo moment.

### Phase 14 - Sharing And Download Tools (tag: `phase-14-sharing-download`)

11. Implement `create_share_link`/`get_share_status`/`revoke_share_link`, wrapping
    `ShareRepository` exactly like `diagramsRouter`'s existing share routes.
12. Implement `export_diagram` (`"json"` and `"scaffold"` formats only — see
    [Non-Goals](#non-goals)), reusing `generateScaffold()` and `fflate` server-side.

**Testing**: cover both export formats' content, and that a revoked/nonexistent diagram id
behaves identically to the existing REST routes' `404` posture.

**Definition of done**: OpenCode can create a share link for a diagram and download its project
scaffold as a local file, using only MCP tool calls.

### Phase 15 - Verification (tag: `phase-15-verification`)

**Status: items 13–15 complete.** Coverage across all three Vitest projects is 100%
(statements/branches/functions/lines); formatting, linting, type checking, coverage, the
production build, Wrangler generation/type checks, and `terraform fmt`/`validate` all pass;
`README.md`, `DEMO.md`, and `EXPLAIN-DEMO.md` are extended per item 15 below. **Item 16 remains an
outstanding manual step**, for the same reason Phase 11's own live-account round trip did: this
repository's standing rule against touching real account infrastructure without explicit request
applies to a real deployment and a real OpenCode session against it.

13. Close coverage gaps across all three Vitest projects (including the new
    `diagram-session`/`graph-mutations`/`mcp` modules).
14. Run formatting, linting, type checking, coverage, production build, Wrangler
    generation/type checks, `terraform fmt -check`, and `terraform validate`.
15. Extend `README.md` (new required Access permissions if any, the `/mcp` endpoint, Managed
    OAuth as an operator-visible dashboard toggle to verify post-deploy), `DEMO.md` (a
    presenter script section covering: open the editor in one window, run an OpenCode session in
    a terminal beside it, ask OpenCode to add a node, watch it appear live with the "Updated by an
    agent" toast, then show the `via: "mcp"` field in Workers Logs), and `EXPLAIN-DEMO.md` (what
    the remote MCP server and its live-sync channel teach, the design's relationship to
    `docs/09-ARCHITECT.md`'s Post-MVP collaboration work, and further reading — see
    [References](#references) below).
16. Manual smoke check on the deployed hostname: a real OpenCode session completing the Managed
    OAuth login flow, and calling at least one tool from every category in the [Remote MCP Tool
    Catalog](#remote-mcp-tool-catalog). `demos/architect/MCP-VALIDATION.md` is the step-by-step
    runbook for performing this check (and re-running it after a later change to the MCP surface);
    it is not itself a substitute for actually running it once against a real deployment.

**Definition of done**: every item in this repository's [Completion
Criteria](../AGENTS.md#completion-criteria) holds for this add-on specifically, and a presenter
can run the full `DEMO.md` script end to end without manual workarounds beyond what is
documented.

## Demo Flow Addition

Insert after Demo 9's existing dashboard/editor walkthrough in `DEMO.md`:

1. Open a diagram in the browser editor. Note the empty canvas or an existing blueprint.
2. In a terminal, start an OpenCode session and connect it to `https://architect.cfapps.uk/mcp`.
   Complete the Managed OAuth browser login when prompted — the same login screen the editor
   itself uses.
3. Ask OpenCode: "Add a Worker node called API and a D1 node called Database, and connect them
   with a service-binding edge." Watch the browser tab — still open, untouched — update live,
   with the "Updated by an agent" toast.
4. Ask OpenCode: "Create a share link for this diagram." Read the returned URL back and open it
   in a private/incognito window to show the anonymous read-only viewer already reflects the new
   nodes.
5. Ask OpenCode: "Download this diagram's Cloudflare project scaffold." Show the resulting local
   ZIP's `wrangler.toml` already contains the D1 binding the agent just added.
6. Open Workers Logs and filter for `diagram_updated` events, pointing out the `via: "mcp"` field
   distinguishing this from an ordinary browser edit.

## Relevant Skills

- `cloudflare`
- `cloudflare-one` (Managed OAuth is an Access capability)
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `agents-sdk` (MCP server/handler APIs)
- `durable-objects`
- `testing-durable-objects` (hibernatable WebSocket tests for `DiagramSession`)
- `workers-best-practices`
- `wrangler`

Skills do not replace current documentation. MCP server handler APIs on the Agents SDK are
explicitly named as fast-moving in this document's own [Prerequisites](#prerequisites) — retrieve
current sources before relying on any signature, flag, or behavior above.

## References

### Model Context Protocol / Cloudflare Agents

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Cloudflare Agents: Model Context Protocol](https://developers.cloudflare.com/agents/model-context-protocol/)
- [MCP handler APIs (`createMcpHandler`)](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP Tools](https://developers.cloudflare.com/agents/model-context-protocol/protocol/tools/)
- [MCP Authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)
- [The next generation of MCP (Cloudflare blog, 2026-08-06 — the MCP 2026-07-28 spec and
  `createMcpHandler`'s graduation into the official MCP TypeScript SDK)](https://blog.cloudflare.com/mcp-v2/)
- [MCP Client Registration (Client ID Metadata Documents vs. Dynamic Client
  Registration)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- [`anthropics/claude-code#84263`](https://github.com/anthropics/claude-code/issues/84263) — real
  evidence Claude Code has already migrated to CIMD; see the Access Model section's note on why
  this does not change this document's `dynamic_client_registration` choice

### Cloudflare Access

- [Secure MCP servers with Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [`cloudflare_zero_trust_access_application` resource (`oauth_configuration`)](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application)

### Durable Objects

- [Durable Objects: WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
