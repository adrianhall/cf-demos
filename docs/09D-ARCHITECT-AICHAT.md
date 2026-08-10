# Demo 9D: Architect AI Chat

Directory: `demos/architect` (extends [Demo 9](./09-ARCHITECT.md), [Demo 9B](./09B-ARCHITECT-MCP.md),
and [Demo 9C](./09C-COLLABORATIVE-EDITING.md) — same demo, same domain, no new deployable unit)

Domain: `architect.cfapps.uk` (unchanged)

Status: Draft implementation plan — no code exists yet. Requires
[Demo 9](./09-ARCHITECT.md)'s Phases 0–10, [Demo 9B](./09B-ARCHITECT-MCP.md)'s Phases 11–15, and
[Demo 9C](./09C-COLLABORATIVE-EDITING.md)'s Phases 16–20 **all** already shipped — this document
is sequenced strictly last, after both follow-ons, not independent of either. See
[Prerequisites](#prerequisites).

Cloudflare products added by this follow-on: **Workers AI** (`AI` binding) and **AI Gateway**
(`cloudflare_ai_gateway`). No new Durable Object class, no new D1 table, and no new HTTP route.
This document extends the **existing** `DiagramSession` Durable Object 9B introduced and 9C
already made bidirectional, giving it a fourth capability (running an AI conversation) alongside
its existing three (live push, human WebSocket operations, MCP-agent operations). It also has
`DiagramSession` act as an outbound **MCP client** to Cloudflare's own public documentation server
(`https://docs.mcp.cloudflare.com/mcp`) for one tool call — an ordinary outbound `fetch()`, not a
provisioned product.

## Prerequisites

- `docs/09-ARCHITECT.md` Phases 0–10, `docs/09B-ARCHITECT-MCP.md` Phases 11–15, and
  `docs/09C-COLLABORATIVE-EDITING.md` Phases 16–20 implemented and deployed, in that order. In
  particular, this document assumes the following already exist exactly as those documents
  specify, and changes none of them:
  - `src/worker/diagrams/graph-mutations.ts` (9B) — the pure `addNode`/`updateNode`/`removeNode`/
    `addEdge`/`updateEdge`/`removeEdge` vocabulary.
  - `src/worker/diagram-session/diagram-session.ts`'s `DiagramSession` Durable Object (9B), with
    9C's additions: an in-memory `this.graph`/`this.sequence`/`this.writeChain`, the
    `applyOperation()`/`applyWholeGraphReplace()`/`getSnapshot()` RPC surface, the full WebSocket
    message protocol (`operation`/`cursor_moved`/`selection_changed` in, `graph_snapshot`/
    `presence_snapshot`/`operation_applied`/`operation_rejected`/`presence_joined`/`presence_left`/
    `cursor_moved`/`selection_changed` out), and `GET /api/diagrams/:id/live`'s owner-or-
    collaborator pre-upgrade check.
  - 9C's `DiagramRepository.findAccessible()` and the `diagram_collaborators` table.
  - `PUT /api/diagrams/:id/graph` already calling `DiagramSession.applyWholeGraphReplace()` (9C),
    not writing to D1 directly.
- **This document is sequenced strictly after 9B and 9C — it is not independent of either.** An
  earlier draft of this document scoped itself to work standalone, computing a chat turn's result
  in a stateless HTTP handler and relying on the browser's own autosave to persist it. That draft
  is superseded: with 9C's collaboration model already in place, this document instead runs the
  chat turn **inside** `DiagramSession` itself — see [Why This Runs Inside
  `DiagramSession`](#why-this-runs-inside-diagramsession) for why that is a better fit once 9C
  exists, not merely a convenient reuse.
- This is the "AI-generated architecture proposals" half of `docs/09-ARCHITECT.md`'s [Post-MVP
  section](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) — the half
  `docs/09C-COLLABORATIVE-EDITING.md` explicitly declined to build ("a separate, unrelated
  capability (Workflows, Workers AI) with their own design questions and get their own future
  document if and when they are scoped"). This document **is** that future document, and it
  deliberately does not use the pre-MVP plan's originally-named `ArchitectureWorkflow` (a
  Workflows-backed generator) — see [Non-Goals](#non-goals) for why a Workflow is unnecessary
  here.
- Re-verify every product surface named below before implementing, per this repository's standing
  rule that skills and prior docs bias toward retrieval over pre-trained knowledge: the Workers AI
  model catalog, AI Gateway's `env.AI.run()`/`gateway` binding options, and the MCP client package
  surface are all fast-moving — [Phase 21](#phase-21---spike-tag-phase-21-ai-chat-spike) exists
  specifically to re-confirm each one, not to take this document's names and shapes as settled.
  Re-verify, too, that a Durable Object's asynchronous execution genuinely continues after the
  WebSocket connection that triggered it disconnects — the specific platform behavior [Why This
  Runs Inside `DiagramSession`](#why-this-runs-inside-diagramsession) depends on — against current
  documentation, not this document's description of it, matching 9C's own precedent of
  re-confirming Durable Object in-memory/hibernation semantics before building on them.

## Summary

Demo 9 shipped a diagram editor a signed-in user drives entirely by hand. 9B added a way for an
external MCP client to drive the same diagram. 9C made `DiagramSession` — one Durable Object per
diagram — the single place every write to a diagram's graph passes through, whether it came from a
human's own WebSocket or from an MCP tool call, and gave every connected viewer a live view of
whichever one just happened. This document adds a **fourth** way to change a diagram — describing
it in plain language to an assistant — and it is deliberately built as one more capability on that
same object, not a new subsystem next to it:

1. **On the diagram selector page** (`/blueprints`, `BlueprintGallery.tsx`), a new "Generate with
   AI" option sits alongside the existing "Blank Canvas" tile and blueprint templates. The
   operator types a description ("I want to build the backend for a real-time strategy game like
   *X*"); the assistant proposes an initial set of Cloudflare products and connections, explains
   its choices, and — once the operator is happy — opens straight into the full editor with that
   diagram already in place and already saved.
2. **Inside the editor**, a new "AI Assistant" toggle opens a chat conversation in the same
   sidebar slot the properties panel already occupies. The user can ask the assistant to change
   the diagram ("add a Durable Object for matchmaking and connect it to the Worker"), ask it to
   explain what is already on the canvas, or ask for advice — and watch the canvas update live, in
   the same tab **and in every other tab currently open on the same diagram**, exactly like a
   human collaborator's edit would under 9C.

Both entry points send an ordinary WebSocket message (`chat_message`) over the **same**
`/api/diagrams/:id/live` connection 9C's editor already opens on mount — no new HTTP route, no new
Server-Sent Events endpoint. `DiagramSession` runs a bounded, model-driven tool-calling loop
against Workers AI (reached through AI Gateway) directly inside its own `fetch()`/WebSocket message
handling, and every graph-mutating tool call — `add_node`, `update_node`, `remove_node`,
`add_edge`, `update_edge`, `remove_edge` — is executed by calling the object's **own**
`applyOperation()` RPC (9C), with a new `origin: "ai-chat"`, alongside the existing `"human"` and
`"agent"` origins. One additional tool, `search_cloudflare_documentation`, lets the assistant
consult Cloudflare's own current product documentation through Cloudflare's public
[documentation MCP server](https://docs.mcp.cloudflare.com/mcp), with clickable source links
surfaced back into the chat transcript.

Because graph mutations ride the object's existing `applyOperation()`/write-chain machinery, this
document adds **no new persistence code at all** — every byte the assistant changes is written to
D1 by the exact same code path 9C already built and tested for human and MCP-agent writes. It also
means an assistant-driven change is exactly as durable, and exactly as visible to every other
connected viewer, as a human's own edit — not a separate, weaker guarantee bolted on beside it.

## Why This Runs Inside `DiagramSession`

An earlier draft of this document deliberately avoided a Durable Object: each chat turn was a
plain, stateless Hono route computing an in-memory graph and handing it back over Server-Sent
Events, on the reasoning that a bounded, request/response-shaped conversation doesn't need
persistent, coordinated state the way Demo 6's long-lived, cost-tracked `AIChatAgent` does. That
reasoning is still correct as far as it goes — this document genuinely does **not** need
Demo 6's specific reasons for a Durable Object (a listed, reopenable chat history; asynchronous,
retried cost reconciliation against AI Gateway's log API; tool side effects with their own storage
lifecycle). But two different, real requirements remain, and once 9C already exists, satisfying
them means reusing its object rather than declining to use one:

- **Resilience across a dropped connection.** A tool-calling loop against a large model can run
  several sequential rounds, each itself several seconds — a genuinely long-lived operation. A
  plain Worker `fetch()` handler is tied to the lifetime of the request that started it: if the
  client disconnects (a backgrounded tab, a network blip, the user simply closing the panel), the
  runtime cancels the in-flight handler and whatever the model was about to do next is lost, along
  with the compute already spent producing it. A Durable Object does not have this limitation —
  its asynchronous execution is a property of the *object*, not of any one caller's connection, so
  a chat turn kicked off by a WebSocket message keeps running inside `DiagramSession` even if that
  particular socket goes away, and every mutation it completes is still applied and broadcast to
  whoever else is connected. A reconnecting client sees the diagram's current state either way,
  via 9C's own `graph_snapshot`-on-connect behavior — it does not need to have watched the turn
  happen to end up correct.
- **Serialized correctness once 9C's collaboration exists.** With two authenticated humans able to
  edit the same diagram concurrently (9C), a chat turn computed against a graph snapshot read once
  at the start of a multi-second conversation risks acting on a graph a collaborator has since
  changed. Running the turn's tool calls through `DiagramSession`'s own `applyOperation()` — the
  same single-threaded execution context 9C already uses to make "no interleaving between two
  concurrent writers" true for humans and MCP agents — extends that same guarantee to the
  assistant for free, rather than reintroducing a stale-read race this document would otherwise
  have to reason about on its own.

This is a small extension of `DiagramSession`'s existing scope, not a new object: exactly the
"scope the class's capabilities up... rather than introducing a differently-named second Durable
Object" principle `docs/09-ARCHITECT.md`'s own Post-MVP section already recommended when it first
described this object.

## Goals

- Let an operator describe an architecture in plain language on the diagram selector page and get
  a working, editable initial diagram built from real Cloudflare catalog products.
- Let a signed-in user, from inside the editor, converse with an assistant that can both **explain**
  the current diagram and **change** it — using the same granular node/edge vocabulary a person
  driving the palette and properties panel already uses, and the same live-collaboration channel
  9C already built.
- Ground the assistant's product choices and explanations in **current** Cloudflare documentation,
  with visible source links, rather than relying solely on the model's training data.
- Make an assistant-driven change exactly as durable and exactly as visible to every other
  connected collaborator as a human's own edit — not a second-class write path.
- Make the editor's right-hand sidebar (today fixed at a single width, hosting only the properties
  panel) a **shared, expandable** slot for both the properties panel and the new chat panel, and
  make the left-hand product catalog easy to get out of the way when the chat panel needs the
  room.

## Non-Goals

- **A Workflow-backed generator.** The pre-MVP plan this document supersedes named
  `ArchitectureWorkflow` (Workflows-backed proposal generation). A diagram-generation request is a
  single bounded conversation — at most a handful of tool-calling round trips — with no multi-day
  durability, human-in-the-loop pause, or cross-request retry requirement a Workflow exists to
  provide; using one here would add a product with no matching need.
- **A new Durable Object class.** This document extends `DiagramSession`; it does not introduce a
  `ChatSession` or any other second per-diagram object. See [Why This Runs Inside
  `DiagramSession`](#why-this-runs-inside-diagramsession).
- **Persistent, listed, reopenable chat history**, the way `docs/06-AGENTIC-CHAT.md`'s chats are.
  A conversation's *text* (as opposed to the diagram changes it produces, which are fully durable)
  remains connection-scoped, ephemeral state inside `DiagramSession` — exactly like 9C's own
  `cursor_moved`/`selection_changed` presence data, discarded on hibernation/eviction and never
  written to D1. Reloading the editor starts a fresh conversation; the diagram itself is
  unaffected, since that is what actually persisted.
- **A user-visible model selector.** Unlike `docs/05-AI-CHAT.md`'s deliberate model-comparison
  lesson, this feature's lesson is "an assistant can operate the same tools a person does," not
  model comparison — one operator-configured model runs every turn (see [Model And AI
  Gateway](#model-and-ai-gateway)).
- **External (non-Workers-AI) model providers.** Every model call in this document is a Workers AI
  model reached through the `AI` binding and AI Gateway, matching `docs/06-AGENTIC-CHAT.md`'s own
  equivalent non-goal.
- **Rewriting or extending Demo 9's Access model.** No new Access application, destination, or
  policy — see [Access Model](#access-model).
- **Any change to 9B's MCP tool catalog/Managed OAuth setup, or to 9C's collaborator model,
  concurrency policy, or presence protocol.** This document adds one more `origin` and one more
  inbound/outbound message family to `DiagramSession`'s existing protocol; it does not alter how
  9B's tools or 9C's human operations already work.
- **Voice, image, or file-upload input.** The assistant's only input is typed text and the
  diagram's own current graph — no speech-to-text (`docs/06-AGENTIC-CHAT.md`'s and
  `docs/17-CONVERSATION-BRIDGE.md`'s lesson), no image generation, no document upload.
- **A server-side auto-layout algorithm.** `docs/09B-ARCHITECT-MCP.md` needed one (its
  `auto_layout_diagram` MCP tool) because an external MCP client has no browser to fall back on.
  This document's chat is always driven from a page with a real, attached browser — see [Node
  Placement And Auto-Layout](#node-placement-and-auto-layout) for why that lets this document avoid
  `elkjs`'s confirmed `workerd` incompatibility entirely, rather than needing a grid-placement
  fallback of its own.

## Access Model

No changes of any kind. This document adds no new HTTP route and no new WebSocket route — the
**only** new surface is a new message type on the WebSocket connection `GET /api/diagrams/:id/live`
already opens, and that route's owner-or-collaborator pre-upgrade check (`findAccessible()`, 9C)
already covers every actor who could send one. There is no new Access application, policy,
destination, or Terraform diff for Access at all.

Every `chat_message` `DiagramSession` receives is already attributed to a verified identity via
9C's existing WebSocket Hibernation API attachment (the same mechanism that already tags every
`operation` message with its sender) — this document adds no authentication or authorization code
of its own.

## Model And AI Gateway

- One AI Gateway, provisioned by Terraform (`cloudflare_ai_gateway`, see [Infrastructure
  Changes](#infrastructure-changes)), fronts every `env.AI.run()` call `DiagramSession` makes.
  Every call passes `{ gateway: { id: env.AI_GATEWAY_ID } }` so every chat turn — generation or
  in-editor — is visible in one place in the Cloudflare dashboard's AI Gateway logs, with request
  volume, latency, token usage, and cost.
- The model is a single, operator-visible-but-not-user-selectable Worker var, `AI_CHAT_MODEL`,
  defaulting to **`@cf/zai-org/glm-5.2`** — confirmed, as of this writing, as Cloudflare's own
  current example model for the unified Workers AI/AI Gateway binding (Cloudflare's 2026-08-07
  "Workers AI and AI Gateway unify model access and billing" changelog entry). **Moonshot AI's
  Kimi K2 family** (published under `@cf/moonshotai/...`, exact current catalog id and version
  suffix to be confirmed against the live model catalog — see
  [Phase 21](#phase-21---spike-tag-phase-21-ai-chat-spike)) is the documented alternate to try;
  both are large, tool-calling-capable general models, and swapping between them is a one-line
  `wrangler.jsonc.tpl` edit and redeploy, not a code change.
- `AI_CHAT_MODEL` is set as a **plain literal value directly in `wrangler.jsonc.tpl`**, not a
  `{{placeholder}}` sourced from a Terraform output — it is a static demo choice with no resource
  backing (AGENTS.md's carve-out: "Do not thread a value like this through a Terraform
  output/`{{placeholder}}` when it is a static demo choice already fixed directly in the .tf file
  ... that adds indirection with no actual single-source-of-truth benefit"). `AI_GATEWAY_ID`, by
  contrast, **is** a `{{placeholder}}`/Terraform output, exactly like `d1_database_id`.
- **Function calling with Workers AI is non-streaming**
  ([Workers AI function calling](https://developers.cloudflare.com/workers-ai/function-calling/)):
  a call with `tools` set returns a complete `{ response, tool_calls[] }` object, not a token
  stream. `DiagramSession`'s chat loop therefore runs every **tool-calling round** of a turn as a
  plain, non-streaming `env.AI.run()` call, and only the turn's **final** round — once the model
  has stopped calling tools and is producing its closing natural-language answer — is requested
  with `stream: true`, its tokens relayed to the originating connection as `chat_token` WebSocket
  messages (see [Message Protocol](#message-protocol)).
- A Durable Object can make the exact same `env.AI.run()`/outbound-`fetch()` calls a Worker's
  `fetch()` handler can — this document introduces no special binding wiring for `DiagramSession`
  beyond adding `"ai": { "binding": "AI" }` to `wrangler.jsonc.tpl` once; every class exported from
  the same Worker script shares its bindings.
- [Phase 21](#phase-21---spike-tag-phase-21-ai-chat-spike) must confirm `AI_CHAT_MODEL`'s chosen
  model actually returns well-formed `tool_calls` for this document's tool schemas when called
  through a plain gateway binding (not a dynamic route) — `docs/06-AGENTIC-CHAT.md`'s own spike
  found several otherwise-solid models fail once routed through an AI Gateway **dynamic route**
  specifically; this document uses a plain gateway (no dynamic routing), so that particular
  failure mode may not apply, but it must not be assumed without a repeat check.
- **No AI Gateway dynamic routing.** Unlike `docs/06-AGENTIC-CHAT.md`, this document has exactly
  one caller, one model, and no per-caller metadata-driven routing decision to make.

## Cloudflare Docs Tool

The assistant's advice and product choices are grounded in Cloudflare's own current documentation
through one tool, `search_cloudflare_documentation`, backed by Cloudflare's own public,
**unauthenticated** documentation MCP server:

- **Server**: `https://docs.mcp.cloudflare.com/mcp` — "Documentation server: Get up to date
  reference information on Cloudflare," listed under [Cloudflare's own MCP
  servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).
  Confirmed (its own README) to require **no OAuth or API token** — every request is anonymous.
- **Client**: a plain `Client` + `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`
  (the SDK v2 client package `docs/09B-ARCHITECT-MCP.md`'s own References section already points
  at), opened fresh, used for exactly one `callTool({ name: "search_cloudflare_documentation",
  arguments: { query } })`, and closed — all inside `src/worker/ai/docs-client.ts`, called from
  `DiagramSession`'s own code exactly like any other outbound `fetch()` a Durable Object can make.
- **Deliberately not the Agents SDK's `MCPClientManager`** (`this.addMcpServer()`/`this.mcp`). That
  manager exists to hold a *persistent* connection's state (OAuth tokens, reconnection,
  subscriptions) across a long-lived `Agent` — real value for a server that needs authorization or
  needs to stay connected between calls, neither of which is true here: the target server is
  public and stateless (a fresh server per request, by its own README), so a short-lived client
  that connects, calls one tool, and disconnects within the same tool-call round is simpler.
- **Failure handling**: a docs lookup that times out or errors is treated as non-fatal to the
  turn — the tool result returned to the model is a plain "documentation search is currently
  unavailable" string, never a thrown error that aborts the whole chat turn.
- **Result shape surfaced to the model and the client**: `{ title, url, snippet }[]`, normalized
  from the upstream tool's content blocks. The chat UI renders these as a small, clickable
  "Sources" list under the assistant's message.
- **Logging**: `ai_docs_lookup_performed` records only `resultCount` and `latencyMs` — never the
  query text or the returned snippets, matching `docs/05-AI-CHAT.md`'s "never prompt or response
  content" logging discipline.

## Shared Graph Mutation Service

`src/worker/diagrams/graph-mutations.ts` already exists exactly as `docs/09B-ARCHITECT-MCP.md`
specifies, and this document imports it unchanged:

| Function | Behavior |
| --- | --- |
| `addNode(graph, input)` | Appends `{ id: crypto.randomUUID(), type: "cf-node", position, data: { typeId, label, description } }`. |
| `updateNode(graph, nodeId, patch)` | Merges `patch` into the node's `data` (and/or `position`); throws `notFound()` if `nodeId` does not exist. |
| `removeNode(graph, nodeId)` | Removes the node and cascades removal of every edge referencing it. |
| `addEdge(graph, input)` | Appends `{ id: crypto.randomUUID(), type: "cf-edge", source, target, data: { edgeType, label, description, protocol } }`; validates both endpoints exist first. |
| `updateEdge(graph, edgeId, patch)` / `removeEdge(graph, edgeId)` | Symmetric to the node versions. |

This document does not call these functions directly — it calls `DiagramSession.applyOperation()`
(9C), which already calls them internally against `this.graph`, persists via the object's own
write chain, and broadcasts the result. See [Chat Loop And Tool
Execution](#chat-loop-and-tool-execution).

This document does **not** need `graph-mutations.ts`'s `autoLayout()` entry — see [Node Placement
And Auto-Layout](#node-placement-and-auto-layout) for why this document's chat never needs a
server-side layout algorithm, sidestepping 9B's confirmed `elkjs`/`workerd` incompatibility
entirely rather than needing its grid-placement fallback.

`typeId` and `edgeType` arguments are validated against `src/catalog.ts`'s `NODE_TYPE_MAP`/
`EDGE_TYPES` before a tool call is even turned into an `applyOperation()` call — an unrecognized
value is reported back to the *model* as a tool error (with the list of valid values), not thrown,
so the model can self-correct within the same turn.

## Chat Loop And Tool Execution

`DiagramSession` gains one new private method, `handleChatMessage(clientRequestId, text,
actorEmail)`, invoked from its existing WebSocket message handler when an inbound frame's `type`
is `chat_message` (see [Message Protocol](#message-protocol)). The implementation logic itself
lives in an ordinary, independently testable module, `src/worker/ai/chat-engine.ts`, imported and
called by `DiagramSession` — domain logic stays out of the Durable Object's own glue code, per this
repository's Source Organization conventions, exactly as `graph-mutations.ts` already does for 9C.

### Inputs

`chat-engine.ts`'s `runDiagramChatTurn()` takes:

- `graph: GraphData`, `title`/`description: string` — read directly from `DiagramSession`'s own
  already-hydrated `this.graph`/diagram metadata (9C's `blockConcurrencyWhile()`-guarded
  hydration) — never re-fetched from D1 for this purpose, and never supplied by the client. The
  assistant always reasons about the object's own live, authoritative state.
- `messages: { role: "user" | "assistant"; content: string }[]` — the plain conversational text
  exchanged so far **on this connection**, held as a small in-memory array attached to the
  WebSocket (mirroring 9C's own per-connection ephemeral state, e.g. its per-identity display
  color) — not persisted, not shared across connections, discarded on disconnect or hibernation
  eviction. This is deliberately excluded from `this.graph` and from D1: it is conversational
  memory, not diagram state.
- A callback, `applyMutation(op)`, that `chat-engine.ts` calls once per graph-mutating tool
  invocation; `DiagramSession` supplies this as a thin closure around its own
  `this.applyOperation(op, actorEmail, "ai-chat")` — `chat-engine.ts` itself has no knowledge of
  `DiagramSession`'s internals, D1, or WebSockets; it only knows "here is a function that applies
  one operation and tells me whether it succeeded."

### The loop

1. Build a **system prompt** from `src/worker/ai/catalog-context.ts`'s `buildCatalogPromptContext()`
   — a compact, per-request digest of every `src/catalog.ts` `NODE_TYPES`/`EDGE_TYPES` entry,
   generated fresh from the same catalog module the palette and properties panel already render
   from, so it can never drift from the real product set.
2. Run `env.AI.run(AI_CHAT_MODEL, { messages: [...system, ...history, ...toolMessages], tools:
   TOOL_DEFINITIONS }, { gateway: { id } })` — non-streaming.
3. If the response carries `tool_calls`, execute each one:
   - A graph-mutating tool call (`add_node`/`update_node`/`remove_node`/`add_edge`/`update_edge`/
     `remove_edge`) is validated against the live catalog, translated into a `graph-mutations.ts`
     -shaped operation, and applied via `applyMutation(op)`. A rejection (9C's existing
     `operation_rejected` case — e.g. the model names a node id a concurrent human or MCP-agent
     operation already removed) is fed back to the model as a plain tool error, exactly like a
     hallucinated `typeId` is, so the model can adapt within the same turn rather than the turn
     failing outright.
   - `rename_diagram` updates the diagram's title/description directly via
     `DiagramRepository.updateMetadata()` (unchanged from 9B's own tool) and is broadcast to every
     connection as a small `diagram_renamed` message (see [Message
     Protocol](#message-protocol)) — title/description are diagram metadata, not part of
     `GraphData`, so they do not go through `applyOperation()`.
   - `search_cloudflare_documentation` calls `docs-client.ts`; its result never touches `this.graph`.
   - Each tool's result is appended as a `role: "tool"` message to a **turn-local** message array
     (not the persisted per-connection `messages` history — only the final user/assistant text
     pair joins that), and a `chat_status` frame is sent to the originating connection describing
     what just happened. The loop returns to step 2, capped at **8 rounds**, after which the model
     is told (via one synthetic tool result) it has reached its action limit for this turn.
4. Once a round returns no `tool_calls`, re-run **that same round only** with `stream: true` and
   relay `chat_token` frames as they arrive to the originating connection only.
5. Append the final `{ role: "user", content: text }`/`{ role: "assistant", content:
   assistantText }` pair to the connection's own ephemeral `messages` history, and send
   `chat_done`.

A chat turn is **not** one atomic transaction across all of its tool calls — each individual
`applyOperation()` call is independently safe and can interleave with a concurrent human or
MCP-agent operation arriving on a different connection between rounds, exactly as any two
independent callers already can under 9C's own last-applied-wins concurrency model. This document
does not change that model; it adds a third kind of caller to it.

### Tool catalog

| Tool | Effect | Notes |
| --- | --- | --- |
| `add_node` | `applyOperation({ kind: "add_node", ... })` | `position` is optional in the tool schema; when omitted, a small internal `nextGridPosition(graph)` helper (staggered rows, keyed off the current node count) assigns one. |
| `update_node` | `applyOperation({ kind: "update_node", ... })` | Patchable fields: `label`, `description`, `typeId`, `position`. |
| `remove_node` | `applyOperation({ kind: "remove_node", ... })` | — |
| `add_edge` | `applyOperation({ kind: "add_edge", ... })` | — |
| `update_edge` | `applyOperation({ kind: "update_edge", ... })` | Patchable fields: `edgeType`, `label`, `protocol`, `description`. |
| `remove_edge` | `applyOperation({ kind: "remove_edge", ... })` | — |
| `rename_diagram` | `DiagramRepository.updateMetadata()` + broadcast `diagram_renamed` | Typically the model's first call during generation. |
| `search_cloudflare_documentation` | `docs-client.ts` | The only tool with no effect on the diagram. |

Every tool's Zod schema includes a `.describe()` per field and the top-level tool description
states its scope plainly, matching 9B's own tool-design convention.

## Message Protocol

Extends 9C's existing `/api/diagrams/:id/live` WebSocket protocol (whatever shared type definition
9C's own implementation introduces for it — e.g. a `diagram-session-protocol.ts` — gains these
members; this document does not create a second, parallel protocol file):

**Client → `DiagramSession`** (new, alongside 9C's `operation`/`cursor_moved`/`selection_changed`):

| Type | Payload | Behavior |
| --- | --- | --- |
| `chat_message` | `{ clientRequestId, text }` | Runs one turn of [Chat Loop And Tool Execution](#chat-loop-and-tool-execution) against this connection's own ephemeral conversation history. |

**`DiagramSession` → client** (new, alongside 9C's `graph_snapshot`/`presence_snapshot`/
`operation_applied`/`operation_rejected`/`presence_joined`/`presence_left`/`cursor_moved`/
`selection_changed`):

| Type | Payload | Recipients |
| --- | --- | --- |
| `chat_status` | `{ clientRequestId, message }` | Unicast to the originating connection only — progress narration ("Checking Cloudflare docs…"), mirroring 9C's existing `operation_rejected` unicast precedent. |
| `chat_token` | `{ clientRequestId, text }` | Unicast. Streamed final-answer text. |
| `chat_tool_result` | `{ clientRequestId, tool, args, result }` | Unicast. Only for `search_cloudflare_documentation` — a graph-mutating tool's effect already arrives as an ordinary `operation_applied` broadcast (see below), which the chat panel also listens for to render its own "Added node: Workers" transcript entries, so it needs no separate frame. |
| `chat_done` | `{ clientRequestId, assistantText }` | Unicast. |
| `chat_error` | `{ clientRequestId, message }` | Unicast. |
| `diagram_renamed` | `{ title, description }` | **Broadcast** to every connection — a `rename_diagram` tool call changes something every viewer's toolbar/tab title reflects. |

Every graph-mutating tool call's effect is an ordinary `operation_applied` message (9C), broadcast
to **every** connection including the originator, with `origin: "ai-chat"` — extending 9C's
existing `origin: "human" | "agent"` field to a third value. This is the entire mechanism by which
**a collaborator who is not chatting still sees the assistant's edits live**: they receive the same
broadcast a human or MCP-agent edit would produce, applied through the exact same client-side
reconciliation code 9C's editor already has, with no chat-specific client code needed to render the
canvas update itself (only to render the chat transcript's own "Added node…" narration, which is a
presentation-layer addition, not a second way of applying the change).

9C's existing "Updated by \<name\>" toast is suppressed for the connection that originated a
`chat_message` (that connection already sees the change happen in its own chat transcript) and
shown, unchanged, to every other connection — reading "Updated by AI Assistant" for `origin:
"ai-chat"`, alongside its existing "Updated by \<name\>" (human) and "Updated by your agent" (MCP)
wording.

## Node Placement And Auto-Layout

This document's chat is, by construction, always driven from a page with a real, attached browser
— either the generation modal on `/blueprints` or the editor itself. Concretely:

- New nodes from `add_node` land at a simple, deterministic staggered grid position
  (`nextGridPosition()`) — legible enough to read the assistant's work as it streams in, not a
  finished layout.
- After a turn that added or removed at least one node, the **client** (not `DiagramSession`) runs
  the editor's own real, ELK-powered auto-layout — the exact same algorithm `Toolbar.tsx`'s "Auto
  Layout" button already runs, extracted into a small shared pure function,
  `computeAutoLayout(nodes, edges, direction)` (`src/client/lib/auto-layout.ts`), factored out of
  `Toolbar.tsx`'s `applyAutoLayout` so the in-editor chat panel, the generation modal, and the
  toolbar button all call identical code. The client then persists the result through the
  **existing** `PUT /api/diagrams/:id/graph` route, which under 9C already calls
  `DiagramSession.applyWholeGraphReplace()` — no new persistence mechanism, and no new WebSocket
  message type for "replace the whole graph," since that REST route already reaches the same
  object.
- `elkjs` still cannot run inside `workerd` (9B's confirmed finding) — this document never needs
  it to, because this call always happens in the browser, whether or not `DiagramSession` is the
  one that applied the underlying mutations.

## Diagram Generation From A Description

Generation is not a bespoke server endpoint — it is the existing blank-diagram creation route
followed by one chat conversation against the same live WebSocket the editor itself uses,
opened early by the generation modal instead of by `DiagramCanvas`:

1. `BlueprintGallery.tsx` gains a new tile, "Generate with AI" (a `Cpu` or `MessageSquare`
   `react-feather` icon), opening `GenerateWithAiModal.tsx` — a textarea ("Describe the
   architecture you want to build") and a "Generate" button.
2. On submit, the modal calls the **existing** `createDiagram({})` (blank) to obtain a real
   `diagramId`, then opens its own `WebSocket` to `/api/diagrams/:id/live` — the same route, same
   owner check, same `DiagramSession` instance a full editor session would use, just from a
   lighter-weight component than `DiagramCanvas`.
3. It sends one `chat_message` synthesized from the description: *"The user wants: \<description\>.
   Propose an initial Cloudflare architecture using only the available product types, with
   sensible connections between them. Call `rename_diagram` with a short, descriptive title.
   Briefly explain your choices when you are done."*
4. The modal renders the same transcript UI the in-editor panel uses (see [In-Editor
   Chat](#in-editor-chat)), reacting to `chat_status`/`chat_token`/`operation_applied`/
   `diagram_renamed`/`chat_done` exactly like the editor's panel does.
5. **The conversation does not have to stop there.** The operator can send a follow-up refinement
   ("actually use Durable Objects instead of KV for matchmaking state") before ever opening the
   full editor — each follow-up is one more `chat_message` on the same open connection, and every
   change it makes is already persisted the moment it happens (via `DiagramSession`'s own write
   chain), not staged for a later explicit save.
6. Once satisfied, an explicit "Open in Editor" button runs the client-side auto-layout pass (see
   [Node Placement And Auto-Layout](#node-placement-and-auto-layout)) if any nodes were added,
   closes the modal's own WebSocket, and navigates with `window.location.href =
   /app/diagram/:id` — `DiagramCanvas` opens its own fresh connection to the same
   `DiagramSession` instance on mount and receives a `graph_snapshot` already reflecting
   everything the conversation produced.
7. If the operator abandons the modal after at least one turn has run, the diagram row created in
   step 2 is left behind, already containing whatever the assistant built — exactly as if they had
   created a blank diagram, edited it by hand, and never reopened it. No attempt is made to make
   diagram creation transactional with the conversation that follows it.

## In-Editor Chat

### Details panel: shared, expandable slot

Today, `DiagramCanvas.tsx` renders `<PropertiesPanel />` directly in a fixed-width (`18rem`)
right-hand sidebar. This document introduces a thin wrapping component,
`src/client/components/editor/panels/DetailsPanel.tsx`, that owns:

- A two-tab switch (`role="tablist"`/`"tab"`/`"tabpanel"`, matching `BlueprintGallery.tsx`'s
  existing category-filter tab pattern) between **Properties** (the existing `PropertiesPanel`,
  unchanged) and the new **AI Assistant** (`AiChatPanel.tsx`).
- The sidebar's **expand/collapse width**: a new header button (`aria-pressed`, matching
  `Toolbar.tsx`'s existing toggle-button convention) switches the panel between its current
  compact `18rem` and a new expanded `~30rem`, applying to whichever tab is active. Persisted
  per-user via a new `src/client/lib/details-panel-preferences.ts` (mirroring
  `palette-preferences.ts`'s `localStorage`-backed pattern).
- Node/edge **selection always switches the active tab to Properties** (an explicit user action
  takes priority over whatever tab happened to be open), matching Bug 4's own "explicit actions
  win" precedent; a user mid-conversation returns to it with one click on the toolbar's "AI
  Assistant" toggle.

`Toolbar.tsx` gains one new icon button (`MessageSquare`, `aria-pressed` bound to a new store
field) that sets the active tab to "AI Assistant" and opens the panel if it was closed. **The
first time this session it is pressed**, if the service palette (`paletteOpen`) is currently open,
it is also closed — reclaiming canvas and sidebar width for the wider chat panel, matching the
scenario's explicit request ("along with the ability to collapse the product catalog"). This is a
one-time nudge, not an enforced state — the palette's own existing toggle (Bug 4) still opens and
closes it freely afterward.

### `diagramStore.ts` additions

- `detailsPanelTab: "properties" | "ai-chat"` (default `"properties"`).
- `detailsPanelExpanded: boolean` (default `false`), toggled independently of `propertiesOpen`.

No new node/edge mutation actions are needed in the store: an AI-chat-originated change arrives as
an ordinary `operation_applied` WebSocket message and is applied through whatever client-side
reconciliation code 9C's own `DiagramCanvas`/`diagramStore.ts` already implements for that message
— this document reuses it unchanged, keyed only off the new `origin: "ai-chat"` value for
transcript rendering and toast wording (see [Message Protocol](#message-protocol)).

### Chat panel UI

`AiChatPanel.tsx` renders:

- A scrollable transcript (`role="log"`, `aria-live="polite"`) of user/assistant text messages,
  interleaved with compact "action" entries driven by incoming `operation_applied` (`origin:
  "ai-chat"`) messages ("Added node: Workers", "Connected Workers → D1 (Binding)") and
  `chat_tool_result` messages ("Searched Cloudflare docs for '…'" with its returned `Sources`
  links) — not just icons/colors, so the same information reaches a screen reader user.
- A composer: a labeled `<textarea>`, a `Send` (`react-feather`) submit button (disabled while a
  turn is in flight or the textarea is empty), and a **Stop** button shown only while a turn is
  streaming.
- A "New conversation" control that clears the panel's own local transcript only — it never
  touches the diagram itself, and does not affect `DiagramSession`'s per-connection `messages`
  array beyond the panel simply starting a fresh one client-side (the next `chat_message` sent
  starts the object's own history over too, since both are scoped to the same connection).

`AiChatPanel.tsx` and `GenerateWithAiModal.tsx` both send `chat_message` over whichever WebSocket
they already hold (the editor's own long-lived connection, or the modal's own short-lived one) and
listen for the new message types above — there is no separate client fetch/stream module, since
this document introduces no new HTTP endpoint of its own.

## Data Model

No new D1 table and no change to any existing table's schema. `title`/`description` changes via
`rename_diagram` use 9B's existing `DiagramRepository.updateMetadata()` unchanged. This document's
only structured-log additions are `ai_chat_turn_completed` (`diagramId`, `model`, `toolCallCount`,
`mutated`, `latencyMs`, token counts if reported), `ai_chat_turn_failed` (`diagramId`, `reason`),
and `ai_docs_lookup_performed` (`resultCount`, `latencyMs`) — emitted from inside
`DiagramSession` using whatever structured-logging mechanism 9B/9C's implementation of that object
already established for its own log lines; this document does not introduce a new logging pattern
for Durable Objects. None of these three log events carry diagram content, prompt text, or
response text.

## Infrastructure Changes

- `infra/architect.tf` (or a new `infra/ai-gateway.tf` — either is fine): one `cloudflare_ai_gateway`
  resource, reusing the field set `spikes/01-ai-gateway-dynamic-routing/infra/main.tf` confirmed is
  required to reach a stable, no-op `terraform plan` (several of this resource's fields are
  optional-but-not-computed in the pinned provider's schema and must be pinned explicitly, or the
  API's own server-filled defaults cause perpetual plan drift):

  ```hcl
  resource "cloudflare_ai_gateway" "demo" {
    account_id                 = local.cloudflare_account_id
    id                          = "${local.demo_name}-ai"
    authentication              = false # only this Worker's own binding calls it
    cache_invalidate_on_update  = true
    cache_ttl                   = 0     # chat responses are not cacheable
    collect_logs                = true
    logpush                     = false
    log_management              = 10000000
    log_management_strategy     = "DELETE_OLDEST"
    zdr                         = false
    rate_limiting_interval      = 60
    rate_limiting_limit         = 30 # coarse, gateway-wide demo-cost guard

    # A light, visible cost control for the presenter to point at in the dashboard -- not a
    # precisely-tuned production budget.
    spend_limits = {
      enabled = true
      rules = [{
        limit_type = "cost"
        limit      = 2
        window     = 86400
      }]
    }
  }
  ```

- `cloudflare_worker.demo` gains `depends_on = [cloudflare_ai_gateway.demo]` alongside its existing
  D1/KV/Durable-Object-migration entries — the API is not confirmed to refuse deleting an in-use AI
  Gateway the way it refuses deleting a bound D1 database, but destroying the Worker first is a
  safe, consistent default.
- `infra/outputs.tf` gains `ai_gateway_id` (`cloudflare_ai_gateway.demo.id`).
- `infra/local-outputs.json` gains `"ai_gateway_id": "architect-local-ai"`.
- `wrangler.jsonc.tpl`:
  - Add `"ai": { "binding": "AI" }` — automatically available inside `DiagramSession` since it is
    exported from the same Worker script (9B).
  - Add `"AI_GATEWAY_ID": "{{ai_gateway_id}}"` and `"AI_CHAT_MODEL": "@cf/zai-org/glm-5.2"` (a
    literal, not a placeholder — see [Model And AI Gateway](#model-and-ai-gateway)) to `vars`.
  - No change to `durable_objects`/`migrations` — `DIAGRAM_SESSIONS` and its `new_sqlite_classes`
    entry already exist from 9B/9C and are unaffected; this document adds no schema of its own to
    that object, matching 9C's own "`DiagramSession` never calls `ctx.storage.sql`" precedent.
- `package.json`: add `@modelcontextprotocol/client` (pinned to the exact version the Agents SDK's
  own release supports) as a Worker-side dependency (`zod` already present from 9B). No new
  client-side dependency — the chat panel and generation modal reuse whatever WebSocket client
  code 9C's editor already has.
- `.env.example` gains two permissions: `Workers AI : Edit` (only for local development — the `AI`
  binding has no local simulator) and `AI Gateway : Edit` (for Terraform to provision
  `cloudflare_ai_gateway`).

## Implementation Plan

Phase numbering continues from `docs/09C-COLLABORATIVE-EDITING.md`'s Phase 20, matching that
document's own precedent of continuing numbering from its predecessor now that sequencing is fixed
(9B → 9C → 9D).

### Phase 21 - Spike (tag: `phase-21-ai-chat-spike`)

1. Confirm `AI_CHAT_MODEL`'s candidate model(s) — `@cf/zai-org/glm-5.2` and the current
   `@cf/moonshotai/kimi-...` catalog id — against the **live** Workers AI model catalog: exact id,
   tool-calling support, and that a plain (non-dynamic-route) gateway binding call with this
   document's own tool schemas returns well-formed `tool_calls`. Record the confirmed model id and
   a fallback in `docs/DECISIONS.md`.
2. Confirm `@modelcontextprotocol/client`'s current exports against the pinned Agents SDK release,
   and confirm a real call to `https://docs.mcp.cloudflare.com/mcp`'s
   `search_cloudflare_documentation` tool from a `workerd`-equivalent environment succeeds with no
   authentication.
3. **Re-verify, against current Durable Objects documentation, that an async operation kicked off
   inside a Durable Object's WebSocket message handler keeps executing after the originating
   client disconnects**, and that a reconnecting client to the same object (same `idFromName`)
   observes the results of work that completed while it was away via a fresh `graph_snapshot`.
   This is the specific platform behavior [Why This Runs Inside
   `DiagramSession`](#why-this-runs-inside-diagramsession) depends on; do not take this document's
   description of it as settled.
4. Confirm the `cloudflare_ai_gateway` Terraform resource's required-pinned-fields list (above)
   still matches the pinned provider version's schema.

**Definition of done**: every item above has a written answer in `docs/DECISIONS.md`; the
confirmed model id, docs-client package/version, and the Durable Object resilience behavior are
settled before Phase 22 starts.

### Phase 22 - Chat Tooling And Docs Client (tag: `phase-22-ai-chat-tools`)

1. Implement `src/worker/ai/catalog-context.ts`'s `buildCatalogPromptContext()` and
   `nextGridPosition()`.
2. Implement `src/worker/ai/tools.ts` (Zod schemas + a dispatcher translating a validated tool call
   into either a `graph-mutations.ts`-shaped operation object, a `rename_diagram` call, or a
   `search_cloudflare_documentation` call) — pure, with no `DiagramSession`/D1/WebSocket
   dependency, so it is unit-testable exactly like `graph-mutations.ts` itself.
3. Implement `src/worker/ai/docs-client.ts`'s `searchCloudflareDocumentation(query)` and its
   non-fatal failure path.

**Testing**: unit tests for `buildCatalogPromptContext()`, `nextGridPosition()`, every tool's
validation/dispatch path, and a mocked MCP transport double for the docs client (success, timeout,
malformed response) — no real network call, no D1, no Durable Object involvement anywhere in this
phase.

**Definition of done**: every tool's dispatcher function is independently unit-tested against
fixture `GraphData` values and produces exactly the operation shape `DiagramSession.applyOperation()`
already expects.

### Phase 23 - `DiagramSession` Chat Capability (tag: `phase-23-ai-chat-session`)

1. Implement `src/worker/ai/chat-engine.ts`'s `runDiagramChatTurn()` (the loop in [Chat Loop And
   Tool Execution](#chat-loop-and-tool-execution)), taking `graph`/`title`/`description`,
   `messages`, and an injected `applyMutation` callback — no direct dependency on
   `DiagramSession`, D1, or WebSockets, so it is unit-testable against a fixture Workers AI double
   and a fixture `applyMutation` spy.
2. Wire `DiagramSession`'s WebSocket message handler to recognize `chat_message`, maintain each
   connection's ephemeral `messages` array, call `runDiagramChatTurn()` with `applyMutation`
   closing over `this.applyOperation(op, actorEmail, "ai-chat")`, and relay `chat_status`/
   `chat_token`/`chat_tool_result`/`chat_done`/`chat_error`/`diagram_renamed` per [Message
   Protocol](#message-protocol).
3. Provision `cloudflare_ai_gateway` and the `AI` binding (see [Infrastructure
   Changes](#infrastructure-changes)); apply and re-verify with `terraform plan`.
4. Extend 9C's "Updated by…" toast wording for `origin: "ai-chat"` and suppress it for the
   originating connection.

**Testing**: worker-project unit tests for `runDiagramChatTurn()` against a fixture Workers AI
double (tool-calling round → `applyMutation` call → final streamed round), the round-cap behavior,
and rejected-operation handling. Integration-test `DiagramSession` directly (per the
`testing-durable-objects` skill): a `chat_message` over a real hibernatable WebSocket that adds a
node, asserting the same connection receives `chat_status`/`chat_token`/`chat_done` and an
`operation_applied` with `origin: "ai-chat"`, and that a **second** connected client to the same
object also receives that `operation_applied` broadcast without having sent anything itself. A
disconnect-mid-turn test: close the originating connection after the first tool call round starts,
assert the object still completes the turn and the diagram's D1 row reflects it, and that a fresh
connection afterward receives a `graph_snapshot` showing the result.

**Definition of done**: a scripted conversation that calls `add_node`, `add_edge`, and
`rename_diagram` in one turn produces the exact expected final graph and title/description in D1,
and is visible to a second, non-originating connected client.

### Phase 24 - In-Editor Chat UI (tag: `phase-24-ai-chat-editor-ui`)

1. Extract `computeAutoLayout()` from `Toolbar.tsx`'s `applyAutoLayout`.
2. Implement `DetailsPanel.tsx`, `AiChatPanel.tsx`, and `details-panel-preferences.ts`.
3. Add `detailsPanelTab`/`detailsPanelExpanded` to `diagramStore.ts`; wire `DiagramCanvas.tsx` to
   render `<DetailsPanel />` in place of the direct `<PropertiesPanel />` it renders today.
4. Add the toolbar's "AI Assistant" toggle button and the one-time palette-auto-collapse behavior.
5. Wire `AiChatPanel.tsx` to send `chat_message` over `DiagramCanvas`'s existing WebSocket
   connection and render the new incoming message types, including `operation_applied` entries
   filtered to `origin: "ai-chat"` for its own transcript.

**Testing**: component tests for tab switching (including "selecting a node returns to
Properties"), the expand/collapse toggle and its persistence, transcript rendering from a scripted
sequence of incoming WebSocket messages, the Stop control, and a keyboard-only pass through the
composer and transcript. Accessibility: `role="log"`/`aria-live` announces new assistant text
without flooding, the tab switch matches the ARIA tabs pattern, every icon-only control has an
accessible name.

**Definition of done**: a scripted chat turn against a mocked WebSocket visibly adds nodes/edges to
the canvas (via 9C's own existing `operation_applied` handling, unmodified) and triggers one
client-side auto-layout pass once the turn completes.

### Phase 25 - Diagram Generation From A Description (tag: `phase-25-ai-chat-generation`)

1. Implement `GenerateWithAiModal.tsx` and the "Generate with AI" tile in `BlueprintGallery.tsx`,
   including the modal's own short-lived WebSocket connection to `/api/diagrams/:id/live`.
2. Wire the "Open in Editor" navigation and its auto-layout pass.

**Testing**: a scripted generation turn (create blank → open WS → `chat_message` → observe
`operation_applied`/`chat_done` → close WS → navigate), including a scripted follow-up refinement
turn before "Open in Editor" is pressed, and the abandoned-modal case (diagram row left behind with
whatever was built, no error).

**Definition of done**: entering a description on `/blueprints`, watching the assistant build an
initial diagram, and opening it in the editor works end to end with the resulting diagram already
saved via `DiagramSession`'s own write chain.

### Phase 26 - Verification (tag: `phase-26-ai-chat-verification`)

1. Close coverage gaps across all three Vitest projects, including the new `ai` modules and
   `DiagramSession`'s expanded surface.
2. Run formatting, linting, type checking, coverage, production build, Wrangler
   generation/type checks, `terraform fmt -check`, and `terraform validate`. Run the `web-perf`
   review and a WCAG 2.2 AA review of the new panel/modal UI.
3. Extend `README.md` (the new `Workers AI : Edit`/`AI Gateway : Edit` permissions, the AI Gateway
   dashboard as an operator-visible cost/log surface), `DEMO.md` (see [Demo Flow
   Addition](#demo-flow-addition)), and `EXPLAIN-DEMO.md` (why this document runs inside
   `DiagramSession` rather than as a stateless route, why that required 9B and 9C to exist first,
   and the relationship between `origin: "ai-chat"` and 9C's existing `origin: "human" | "agent"`).
4. Manual smoke check on the deployed hostname: a real "Generate with AI" conversation through to
   an opened, saved diagram; an in-editor conversation that adds nodes, asks a "how does this
   work" question (exercising `search_cloudflare_documentation`), and is undone with Ctrl+Z; **two
   browser profiles open on the same diagram, one chatting with the assistant and one only
   watching**, confirming the second sees the assistant's edits live; a deliberate mid-turn
   disconnect (close the chatting tab while a turn is in flight) followed by reopening the diagram
   and confirming the turn's changes landed anyway; the AI Gateway dashboard showing the resulting
   logs, cost, and configured spend limit.

**Definition of done**: every item in this repository's [Completion
Criteria](../AGENTS.md#completion-criteria) holds for this add-on specifically, and a presenter
can run the full `DEMO.md` script end to end without manual workarounds beyond what is documented.

## Demo Flow Addition

Insert after `docs/09C-COLLABORATIVE-EDITING.md`'s own `DEMO.md` addition:

1. From the dashboard, click **+ New Diagram**, then **Generate with AI**. Type: "I want to build
   the backend for a real-time strategy game like an MOBA — matchmaking, live game state, and a
   leaderboard." Watch the assistant's actions stream in (add Worker, add Durable Object, add D1,
   add KV, connect them) followed by its explanation and Sources links.
2. Ask a follow-up in the same modal: "Actually, use Queues for the leaderboard updates instead of
   writing directly to D1." Watch the diagram change again before opening the editor.
3. Click **Open in Editor**. Reload the page and point out the diagram is already saved and
   already laid out — nothing about opening the editor itself was what saved it.
4. Open the same diagram in a **second browser profile as a collaborator** (9C). Click the first
   window's toolbar **AI Assistant** icon and ask: "Add a KV cache in front of the leaderboard
   reads." Watch the node appear live in **both** windows — the collaborator's, which never sent a
   chat message at all, sees the same `operation_applied` broadcast a human edit would have
   produced.
5. In the first window, press **Ctrl+Z** to undo the assistant's last change — showing it is a
   normal, undoable operation, not a special case.
6. Ask: "What does the Durable Object do here, and how does it talk to the Worker?" Watch the
   assistant call `search_cloudflare_documentation` and cite a real, current doc link in its
   answer.
7. Close the chatting browser tab entirely while a new request is mid-flight (ask something that
   triggers a multi-step tool sequence, then close the tab immediately). Reopen the diagram and
   show the requested changes landed anyway — the turn kept running inside `DiagramSession` after
   the tab disconnected.
8. Open the Cloudflare dashboard's **AI Gateway** page for this gateway and show the logged
   requests, their model, latency, and cost, and the configured $2/day spend limit.

## Relevant Skills

- `cloudflare`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `agents-sdk` (MCP client package surface, for the `search_cloudflare_documentation` tool)
- `durable-objects` (extending `DiagramSession`'s existing RPC/WebSocket surface)
- `testing-durable-objects` (multi-client hibernatable WebSocket tests, disconnect-mid-turn tests)
- `workers-best-practices`
- `wrangler`

Skills do not replace current documentation. The Workers AI model catalog, AI Gateway binding
options, the MCP client package surface, and Durable Object execution/hibernation semantics are
all named as needing re-confirmation in this document's own [Prerequisites](#prerequisites) —
retrieve current sources before relying on any model id, signature, option, or platform behavior
above.

## References

### Workers AI / AI Gateway

- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Workers AI function calling](https://developers.cloudflare.com/workers-ai/function-calling/)
- [AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [AI Gateway: Worker binding methods (`env.AI.run()`, `gateway` options)](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [AI Gateway: Workers AI provider integration](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/)
- [`cloudflare_ai_gateway` resource](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/ai_gateway)
- [2026-08-07 changelog: Workers AI and AI Gateway unify model access and billing](https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/)

### Model Context Protocol

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Cloudflare's own MCP servers (documentation server, `docs.mcp.cloudflare.com`)](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
- [`cloudflare/mcp-server-cloudflare`'s `docs-ai-search` app (no-auth, stateless documentation MCP server)](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/docs-ai-search)
- [Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)

### Durable Objects

- [Durable Objects: WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Objects: in-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)

### This Demo's Prior Documents

- [`docs/09-ARCHITECT.md`](./09-ARCHITECT.md) — the MVP this document extends, and the
  [Post-MVP section](./09-ARCHITECT.md#post-mvp-live-collaboration-and-ai-proposals) whose
  AI-proposal half this document resolves.
- [`docs/09B-ARCHITECT-MCP.md`](./09B-ARCHITECT-MCP.md) — introduces `DiagramSession` and
  `graph-mutations.ts`, both extended (not replaced) here.
- [`docs/09C-COLLABORATIVE-EDITING.md`](./09C-COLLABORATIVE-EDITING.md) — makes `DiagramSession`
  bidirectional and gives it the `applyOperation()`/write-chain machinery this document's chat
  turns run through as a third `origin`; a hard prerequisite for this document, not an independent
  sibling.
- [`docs/05-AI-CHAT.md`](./05-AI-CHAT.md) — the curriculum's Workers AI streaming precedent this
  document's "no persistent transcript" scope decision follows.
- [`docs/06-AGENTIC-CHAT.md`](./06-AGENTIC-CHAT.md) — the curriculum's AI Gateway/Terraform
  provisioning precedent (`cloudflare_ai_gateway`'s pinned-field gotchas) this document reuses, and
  the contrasting case (a genuinely persistent, cost-tracked agent) this document's [Why This Runs
  Inside `DiagramSession`](#why-this-runs-inside-diagramsession) section explains this demo does
  and does not have in common with.
