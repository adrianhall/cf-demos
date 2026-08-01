# Demo 6: Agentic AI Chat

Directory: `demos/agentic-ai-chat`

Domain: `agentic-chat.cfapps.uk`

Status: Draft implementation plan

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, R2, Durable
Objects, the **Agents SDK**, **Workers AI**, **AI Gateway** (dynamic routing,
rate limiting, spend limits), and **Dynamic Workers** (the `worker_loaders`
binding and its `globalOutbound` egress-control gateway) for the `getUrl`
tool.

> **Platform prerequisite**: Dynamic Workers are currently available on the
> [Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/)
> only. This is the first demo in this curriculum with that requirement — call
> it out prominently in `README.md`'s prerequisites (Phase 13).

> **Scope note**: an earlier revision of this plan included a Cloudflare
> Access MCP server portal integration (US-11/Phase 12/Spike E in that
> revision). It has been removed — see Non-Goals — and is instead the subject
> of a separate, deliberately lightweight planning document,
> `docs/06-MCP-SUPPORT.md`, to be expanded into a full implementation plan
> once this demo ships.

## 1. Summary

Demo 6 is the curriculum's introduction to the **Agents SDK**, built as a
scaled-down "enterprise AI chat" in the shape of Gemini's AI Chat product. A
signed-in user holds a persistent, multi-turn conversation with an
`AIChatAgent` — one Durable Object per chat — selecting between two AI Gateway
**dynamic routes** ("basic" and "reasoning") whose actual model choice is
further steered by the caller's business/geo metadata. The agent can call
tools (write a Markdown file to R2, fetch a URL through an egress-controlled
path) and load personal and enterprise **skills**. An admin role (a D1 flag,
not an Access concept) can inspect per-user cost, set colleagues' business/geo
metadata, and view cost-by-business and cost-by-geo reports. Every chat and
every agent-generated file can be exported as a Markdown transcript carrying
its cost and token breakdown.

Unlike every earlier curriculum demo, this specification is **feature-driven**
rather than layer-driven. Section 5 states each feature as a user story before
any implementation detail. Section 9's implementation plan is a strict
sequence of **Spikes → Scaffolding → one phase per feature → Cleanup and
documentation**, and every phase ends with a fully functional, fully tested
product tagged in git so any two phases can be diffed.

## 2. Background And Problem Statement

Demo 5 (`demos/ai-chat`) taught Workers AI as a stateless streaming proxy: no
storage, no persistence, one request in, one stream out. Demo 4
(`demos/chat`) taught Durable Objects and WebSockets as the mechanism for
stateful, multi-participant coordination. Demo 6 is where those two lessons
combine and gain a third: an **agent** is a Durable Object that owns not just
connection state but a persistent, resumable conversation with a model,
optionally augmented with tools and external context (skills), and
platform-level governance (routing, rate limits, spend limits) it does not
implement itself.

The backlog names an unusually large capability surface for one demo: dynamic
model routing, speech-to-text, a cost/metadata-aware admin console, two
categories of custom tools, and a skills system. Several of these rest on
**very recently shipped or still-experimental** platform surfaces (AI Gateway
dynamic routing's conditional/rate/budget nodes, the Agents SDK's experimental
Agent Skills, Dynamic Workers' `globalOutbound` egress gateway, itself in open
beta). Treating this as one monolithic build would mean discovering multiple
platform surprises deep into implementation, exactly the failure mode
`docs/05-AI-CHAT.md`'s model-adapter spike was designed to avoid for a single
catalog. Given several independent unknowns, this plan front-loads a **Spikes
phase**: short, disposable, committed proofs of the riskiest mechanisms, each
with a stated aim and a written report, before any feature code is built on
top of an assumption.

The backlog also names a Cloudflare MCP Portal integration. This plan
deliberately **excludes** it (see Non-Goals) in favor of a broader,
enterprise-ready MCP client capability — supporting the current 2026-07-28 MCP
specification directly rather than only what Access's portal product
currently fronts — scoped as its own follow-on project in
`docs/06-MCP-SUPPORT.md` rather than one phase of this one.

Why now, and why this shape: the backlog explicitly asks for this demo to be
broken into user stories with one phase per feature, tagged so reviewers can
diff between them — a deliberate deviation from the single-track phase
numbering used by demos 1–5, because this demo's job is to be a curriculum
capstone-in-miniature for the Agents SDK rather than a single-lesson demo.

## 3. Goals And Non-Goals

### Goals

- Teach the **Agents SDK**'s `AIChatAgent` as the mechanism for a persistent,
  resumable, per-entity AI conversation — one Durable Object per chat.
- Teach **AI Gateway dynamic routing** as a way to move model selection out of
  application code and into governed, versioned, metadata-driven
  configuration (rate limits and spend limits included).
- Demonstrate **tool calling** with two qualitatively different tools: one
  with a pure data-plane side effect (write to R2) and one with a genuine
  security boundary (egress to the public Internet).
- Demonstrate **skills** (personal and enterprise) as a way to extend an
  agent's behavior without touching its code.
- Give every feature a **visible result** and an **observable platform
  behavior** (Workers Logs, AI Gateway analytics, D1 rows, Access logs),
  consistent with the curriculum's principles.
- Ship every phase as an independently reviewable, fully tested, tagged
  increment.

### Non-Goals

- **Sandbox SDK / Containers.** Demo 8 (`demos/opencode`) is the curriculum's
  dedicated container/egress-control lesson — a full Linux environment for
  arbitrary heavier workloads (an OpenCode terminal session). Dynamic Workers
  (Section 6.7) is a deliberately different, lighter-weight primitive
  (isolate-level, not OS-level, sandboxing) chosen for this demo's narrower
  need — controlling one tool's outbound `fetch()` — so the two demos teach
  distinct points on the sandboxing spectrum instead of overlapping.
- **MCP client integration (Cloudflare Access MCP server portals or
  otherwise).** The backlog names this, but it is deliberately deferred to
  `docs/06-MCP-SUPPORT.md` as its own follow-on project rather than one
  phase here. An MCP portal is a narrower integration than what an
  enterprise-ready MCP client needs (Access's own portal product is a
  specific, opinionated on-ramp, not the whole MCP surface), and a proper
  design needs more room than a single feature phase in an already-large
  demo affords. Ship this demo without it; revisit once
  `docs/06-MCP-SUPPORT.md` is expanded into its own implementation plan.
- **Vectorize / RAG.** Demo 14 (`demos/media-search`) owns that lesson.
- **Workflows.** No step in this demo needs durable multi-step orchestration
  beyond what a Durable Object's own SQLite storage and the Agents SDK's
  built-in retry/queue primitives already provide.
- **External (non-Workers-AI) model providers.** Every model this demo calls
  is a Workers AI model, reached through AI Gateway. AI Gateway can proxy
  third-party providers and BYOK keys, but adding them here would mix a
  credential-management lesson into a routing lesson; an operator can extend
  the catalog later.
- **Full duplex voice conversation.** Speech-to-text is a prompt-entry aid
  (record → transcribe → edit → submit), not a live voice channel. Demo 17
  (`demos/conversation-bridge`) owns full-duplex voice.
- **Multi-tenant organizations.** One Cloudflare Access team = one
  organization for this demo. "Business" and "geo" are per-user metadata
  fields, not separate tenants.

## 4. Requirements

### Functional

- Every route requires an authenticated Cloudflare Access identity; no route
  is anonymous (inference and stored conversation history are both
  sensitive/billable).
- A user can create a chat, hold a multi-turn conversation, see it appear in
  a sidebar list titled from its content, and switch between chats.
- A user can choose "basic" or "reasoning" mode; the demo does not expose raw
  model names in that selector — only the two governed dynamic routes.
- A user can dictate a prompt via microphone; the transcribed text populates
  the composer for review, never auto-submits.
- Every chat shows its running cost and prompt/completion token counts.
- An admin (D1 `users.is_admin = 1`) can view every user's cost, edit any
  user's `business`/`geo` metadata, and view cost-by-business and
  cost-by-geo reports. A non-admin gets `403` from every admin route.
- The agent can call a `writeMarkdown` tool that stores a file in R2 attached
  to the chat, and a `getUrl` tool that fetches a URL through an
  egress-controlled path.
- The agent can load **personal** skills (added by their owner) and
  **enterprise** skills (added by an admin), each from an upload or a URL.
- A user can export a chat, or a single agent-generated file, as a Markdown
  document carrying its cost/token breakdown.

### Non-Functional

- **Latency**: first token for a "basic" route model should land in a
  comparable window to demo 5's non-reasoning entries (cold-start aside);
  document actual measurements in `README.md` rather than asserting an
  unverified number here.
- **Cost attribution accuracy**: every completed turn's token counts must be
  attributed to exactly one chat and one D1 usage row; a turn that never
  completes (aborted, errored before first token) must not be double-counted
  or silently dropped — see Failure Modes. The authoritative figure for a
  completed turn is AI Gateway's own logged cost/tokens (`getLog()`), not a
  locally computed estimate; the local estimate exists only as an
  immediately-available, clearly-labeled placeholder until reconciliation
  completes (Section 6.6).
- **Data isolation**: a user must never read another user's chats, files, or
  metadata through any route, admin routes included (admin routes are
  read/write on metadata and read-only on other users' cost, never on their
  conversation content).
- **Least privilege**: the `getUrl` tool must not be able to reach arbitrary
  internal or unapproved external hosts; enforcement must live in the
  Dynamic Worker's `globalOutbound` egress gateway, not only in the tool's
  own application-level URL validation, per Spike C's outcome.
- **Platform prerequisite**: the demo account must be on a Workers Paid
  plan for Dynamic Workers to function (Section 6.7); this is a hard
  deployment precondition, not a soft recommendation.
- **Testability**: every feature phase ships with unit, component, and
  integration test coverage for its new code before the phase is considered
  done — no phase defers testing to "Cleanup".

## 5. User Stories

Each story is tagged with the phase (Section 9) that implements it. Stories
are written from the perspective of an end user unless marked **(Admin)**.

| ID | Phase |
| --- | --- |
| US-1 Core agentic chat | Phase 2 |
| US-2 Chat sidebar and management | Phase 3 |
| US-3 Governed model selection (dynamic routes) | Phase 4 |
| US-4 Voice-to-prompt dictation | Phase 5 |
| US-5 Per-chat cost and token visibility | Phase 6 |
| US-6 Admin cost/metadata console | Phase 7 |
| US-7 Metadata-driven model routing | Phase 8 |
| US-8 Tool: write a file to my chat | Phase 9 |
| US-9 Tool: fetch a URL safely | Phase 10 |
| US-10 Personal and enterprise skills | Phase 11 |
| US-11 Export a chat or a file | Phase 12 |

**US-1 — Core agentic chat.** As a signed-in user, I want to type a prompt
and hold an ongoing conversation with an AI agent, so that I get the same
kind of assistant experience as a consumer AI chat product, backed by
Cloudflare's own platform. *Acceptance*: a submitted prompt streams a
response incrementally; a second prompt in the same chat has access to the
first turn's context; reloading the page and reconnecting resumes the same
conversation from durable storage, not from browser memory.

**US-2 — Chat sidebar and management.** As a signed-in user, I want a
"+ New Chat" control and a list of my previous chats titled from their
content, so that I can manage more than one topic of conversation.
*Acceptance*: "+ New Chat" starts an empty chat and adds it to the sidebar
immediately; each chat acquires a short generated title after its first
exchange; selecting a sidebar entry loads that chat's full history; a user
sees only their own chats.

**US-3 — Governed model selection.** As a signed-in user, I want to pick
"basic" or "reasoning" from a small dropdown, not a raw model name, so that
the actual model used is centrally governed rather than hard-coded in the
browser. *Acceptance*: the dropdown offers exactly two options; each maps to
a named AI Gateway dynamic route, not a literal model ID, in both the
request and any client-visible metadata; changing the platform-side route
configuration changes behavior without a client deploy.

**US-4 — Voice-to-prompt dictation.** As a signed-in user, I want a
microphone control on the composer, so that I can dictate instead of typing.
*Acceptance*: recording produces a text transcript that populates (not
submits) the composer; the user can edit the transcript before sending;
denied microphone permission or a transcription failure surfaces a clear,
recoverable error, not a silent no-op.

**US-5 — Per-chat cost and token visibility.** As a signed-in user, I want to
see each chat's running cost and prompt/completion token counts, so that I
understand what my usage costs. *Acceptance*: the sidebar or chat header
shows a running total that updates immediately after each completed turn and
is visibly labeled as **AI Gateway-confirmed** once AI Gateway's own logged
figures are available, or **estimated** if only the demo's local calculation
has landed so far — the two are never shown as indistinguishable numbers.

**US-6 — Admin cost/metadata console (Admin).** As an admin, I want to see
which users cost the most, and set any user's business (field/product/
leadership) and geo (emea/apac/americas) metadata, so that I can attribute
spend and steer model routing by organizational segment. *Acceptance*: a
non-admin gets `403` from every admin route and sees no admin UI entry point;
an admin sees a ranked list of users by total cost, can edit any user's
`business`/`geo`, and sees cost totals broken down by business and by geo.

**US-7 — Metadata-driven model routing.** As an operator, I want the actual
model chosen within each dynamic route to depend on the caller's business
metadata, so that different segments get different cost/capability
trade-offs automatically. *Acceptance*: two users with different `business`
values, submitting the same route selection ("basic" or "reasoning"), are
routed to different underlying models, verified from AI Gateway logs, with
no client-side difference in the request the browser sends.

**US-8 — Tool: write a file to my chat.** As a signed-in user, I want to ask
the agent to produce a document and have it saved as a real file attached to
my chat, so that I can retrieve it later without copy-pasting from the
transcript. *Acceptance*: when the model calls `writeMarkdown`, a file
appears in R2, a corresponding attachment renders inline in the transcript,
and only the chat's owner can download it.

**US-9 — Tool: fetch a URL safely.** As a signed-in user, I want the agent to
be able to look something up on the web when asked, but I want that access
controlled, not unrestricted. *Acceptance*: a request to fetch an
allow-listed destination succeeds and its content is available to the model;
a request to fetch a non-allow-listed destination is blocked at the platform
layer (not only by application logic) and the agent explains the refusal
rather than failing silently or crashing the turn.

**US-10 — Personal and enterprise skills.** As a signed-in user, I want to
add my own skill (a Markdown instruction bundle, uploaded or from a URL) that
only my chats can use, and as an admin, I want to add an enterprise skill
available to everyone, so that the agent's behavior can be extended without
redeploying the Worker. *Acceptance*: a skill's presence changes the agent's
behavior only when a task matches it (it must not bloat every prompt); a
personal skill is invisible to other users; an enterprise skill is visible to
everyone; removing a skill removes its effect on the next turn.

**US-11 — Export a chat or a file.** As a signed-in user, I want to export a
whole chat, or a single generated file, as a Markdown document that includes
what it cost, so that I can keep or share a record outside the app.
*Acceptance*: exporting a chat produces a single Markdown file with every
turn, tool calls and their results, and a cost/token summary; exporting a
generated file produces a Markdown document wrapping that file's content
with the cost/token context of the turn that produced it.

## 6. Proposed Design

### 6.1 High-Level Architecture

```
Browser (Vue 3 + Vuetify)
  │  WebSocket (a Vue composable wrapping the framework-agnostic AgentClient —
  │  see 6.2a) + REST (chats, admin, skills, exports)
  ▼
Cloudflare Access  ── whole-hostname authenticated app (no bypass)
  ▼
Worker (Hono) ── routing, admin authorization, D1 repositories, R2 file I/O
  │
  ├─ Durable Object per chat: AIChatAgent subclass (Agents SDK)
  │     onChatMessage → ai SDK streamText()
  │       model: workers-ai-provider, routed through AI Gateway dynamic route
  │       tools: writeMarkdown (R2 — no sandboxing needed, no network egress),
  │              getUrl (routed through a Dynamic Worker's globalOutbound
  │              egress gateway — see 6.7),
  │              activateSkill (personal/enterprise skill catalog)
  │
  ├─ D1 ── users (identity + is_admin + business/geo), chats (directory +
  │        titles + route selection), chat_usage (cost ledger),
  │        chat_files (R2 attachment metadata), skills (catalog + source)
  │
  ├─ R2 ── agent-generated files; skill bundle content
  │
  ├─ Dynamic Workers (worker_loaders binding) ── one cached Dynamic Worker
  │     running the getUrl tool's fetch, its globalOutbound bound to an
  │     EgressGateway WorkerEntrypoint (allow-list, logging, optional
  │     credential injection) defined in the main Worker script
  │
  └─ Workers AI ── chat models (via AI Gateway) + speech-to-text
        AI Gateway ── dynamic routes "agentic-chat-basic" / "agentic-chat-reasoning",
                       conditional model nodes keyed on business metadata,
                       rate limits + spend limits scoped by user/business metadata
```

### 6.2 Why `AIChatAgent`, Not A Hand-Rolled Durable Object

Demo 4 hand-rolled a `ChatRoom extends DurableObject<Env>` because the lesson
*was* Durable Object fundamentals. Here the lesson is the Agents SDK's
purpose-built chat agent, which already provides message persistence,
resumable streaming, WebSocket sync, and (per Spike A) integrates with the
`ai` SDK's `streamText()`/tool-calling loop directly — reimplementing that on
a raw Durable Object would teach the wrong lesson and duplicate work the SDK
exists to remove. One `AIChatAgent` subclass, one Durable Object instance per
chat (`getAgentByName`/`routeAgentRequest` keyed on a generated chat ID),
mirrors demo 4's "one Durable Object per coordination atom" principle applied
to a conversation instead of a room.

### 6.2a The Vue Client Speaks `AgentClient` Directly, Not `agents/react`

The Agents SDK's own documented client-side hooks — `useAgent`,
`useAgentChat` — live in `agents/react` and are React-specific. AGENTS.md
mandates Vue 3 for every demo with a browser UI, so this demo does not add
React just to reach for those hooks. Per Spike A's confirmation that
`AgentClient` (the transport those hooks themselves wrap) is
framework-agnostic, this demo builds one small, colocated Vue composable —
`src/client/composables/useChatAgent.ts` — directly on top of it, following
this repo's own `create-adaptable-composable` conventions (accept
maybe-reactive inputs, normalize with `toValue()`, expose reactive refs).
That composable is the **only** place the Agent WebSocket protocol
(message frames, `state` sync, `broadcast()` messages) is spoken; every
Pinia store and every component consumes the composable's reactive
surface, never `AgentClient` or a raw `WebSocket` directly. This mirrors
demo 4's own rule that the socket-lifecycle composable/store is the single
seam between the wire protocol and the rest of the client — reused here
for an Agents SDK connection instead of a hand-rolled one. Section 6.6a
describes the composable's role in the cost ledger's live update
specifically; the same composable is also what Phase 2's streaming
transcript UI is built on for ordinary chat messages.

### 6.3 Why AI Gateway Dynamic Routes, Not A Client-Visible Model Picker

Demo 5 taught model comparison with a client-visible catalog because the
lesson was inference and streaming, and the catalog itself was the
comparison surface. Here, exposing raw model IDs to the browser would leak
an operational decision (which model is cost-appropriate for which business
segment) into client code that has no business making it. AI Gateway's
dynamic routing feature exists exactly for this: the client sends a **route
name** (`dynamic/agentic-chat-basic`), and the platform-side route
configuration — editable without a redeploy — decides the real model,
including per-segment conditionals, rate limits, and spend limits. This is
also the vehicle for US-7 (metadata-driven routing): the conditional node
reads request metadata the Worker attaches (the caller's `business`), not
anything the client can set directly.

### 6.4 D1 Schema (Additive Migrations, One Per Phase)

| Table | Introduced | Columns (non-exhaustive) |
| --- | --- | --- |
| `users` | Scaffolding | `email` (PK), `is_admin`, `created_at` |
| `chats` | Scaffolding | `id` (PK), `owner_email`, `title`, `route`, `created_at`, `updated_at` |
| `chat_usage` | Phase 6 | `id`, `chat_id`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cost_source` (`estimated`\|`gateway`), `gateway_log_id` (nullable), `reconcile_attempts`, `created_at`, `updated_at` |
| `users.business` / `users.geo` | Phase 7 | added by an `ALTER TABLE` migration |
| `chat_files` | Phase 9 | `id`, `chat_id`, `r2_key`, `filename`, `size_bytes`, `created_at` |
| `skills` | Phase 11 | `id`, `owner_email` (`NULL` = enterprise), `name`, `source_type` (`upload`\|`url`), `source_ref`, `r2_key`, `created_at` |

Every migration is a new numbered file under `migrations/`; none is ever
edited after it ships, per the Agents SDK's own migration guidance and this
repo's existing D1 conventions (`demos/todo-app`, `demos/chat`).

### 6.5 Admin Authorization Is An Application Concern, Not An Access Concern

Following AGENTS.md's Public Access guidance, the whole `agentic-chat.cfapps.uk`
hostname is gated by **one** Cloudflare Access self-hosted application with an
`allow` policy requiring authentication (no bypass — inference and personal
chat history are both sensitive), with `audience` set (no reason to skip it
here; there is only one Access application on this hostname, so
cross-application replay is not a design constraint this demo needs to
compensate for). "Admin" is **not** a second Access application — Access has
no concept of this demo's business role. It is a D1 flag
(`users.is_admin`), checked by a `requireAdmin()` Hono middleware on every
`/api/admin/*` route, returning `403` (not a redirect) for a non-admin. The
first admin is bootstrapped the same way `demos/media-drop` threads
`ADMIN_EMAIL` from `.env` through a Terraform output into a Worker var: a
startup-safe, idempotent upsert (`INSERT ... ON CONFLICT DO UPDATE SET
is_admin = 1`) ensures that email is always an admin, regardless of D1 state
after a redeploy or partial teardown.

### 6.6 Cost Ledger Prefers AI Gateway's Own Logged Cost, Not A Local Estimate

Every `env.AI.run()` call made through AI Gateway produces a **log ID**
(`env.AI.aiGatewayLogId`), and that log ID can be exchanged for the
request's authoritative, AI-Gateway-computed prompt/completion token counts
and USD cost via `env.AI.gateway(gatewayId).getLog(logId)`. This is a real
per-request number Cloudflare's own billing/cost-analytics pipeline
produces — not an estimate this demo invents — so it is the **preferred**
source for every `chat_usage` row, with the local per-model pricing-table
calculation (`src/models.ts`, reusing demo 5's verified pricing where the
same models are reused) demoted to an **explicitly-labeled fallback**, never
silently blended with the authoritative figure.

**Why not use `getLog()` as the only source.** `env.AI.run()` returns
`aiGatewayLogId` once the call resolves, but the log entry it points to may
not be queryable via `getLog()` the instant the response finishes — AI
Gateway's own documentation describes at least one of its accounting
features (spend limits) as "eventually consistent," and Spike F (below)
must establish whether logged cost data shares that lag. A chat UI that
blocks a turn's cost readout on that round trip would either feel slow or
occasionally show nothing. So every turn gets an immediately-available
number, honestly labeled, upgraded to the authoritative one when it arrives.

**The two-write, asynchronously-reconciled design:**

1. **Immediate write (`onFinish`)** — the moment `streamText()`'s `onFinish`
   fires, insert a `chat_usage` row from the locally computed pricing-table
   estimate, `cost_source = 'estimated'`, and the turn's `aiGatewayLogId`
   captured for later lookup. The UI can render this instantly.
2. **Reconciliation (Agents SDK scheduling)** — in the same `onFinish`
   handler, call `this.schedule(delaySeconds, "reconcileUsage", { chatUsageId,
   gatewayLogId })` — the Agents SDK's own one-time scheduled-task
   primitive, durable across Durable Object eviction, rather than
   `ctx.waitUntil()` (whose lifetime is tied to the now-finished request and
   is not the right tool for a retryable, possibly-delayed follow-up). The
   exact initial delay and backoff schedule are set from Spike F's measured
   lag, not guessed.
3. **`reconcileUsage(payload)`** calls `getLog(gatewayLogId)`. On success,
   `UPDATE`s the row's `prompt_tokens`/`completion_tokens`/`cost_usd` with
   AI Gateway's figures and flips `cost_source = 'gateway'`. If the log is
   not yet available (confirm the exact not-ready signal in Spike F — a
   `404`, an empty/`null` cost field, or similar), increment
   `reconcile_attempts` and reschedule with backoff, up to a small, bounded
   attempt count (for example 3). Once that bound is reached, the row is
   left as `estimated` **permanently** — this demo does not retry forever,
   and a permanently-`estimated` row is a legitimate, visible outcome, not a
   bug to hide.
4. **The reconciliation task must tolerate its target having disappeared**
   (the chat was deleted, per Phase 3's teardown) between scheduling and
   running — it must exit cleanly, not throw (Section 11).

### 6.6a Live UI Sync Via Agent State And Broadcast, Not A REST Poll

`ChatAgent` already **is** an Agents SDK `Agent` (through `AIChatAgent`), so
it already has a persistent, auto-synced `state` and a `broadcast()` method
to every currently-connected client — the exact mechanism demo 4 had no
equivalent for and had to build a channel-broadcast Durable Object by hand
to get. Reusing it for the cost ledger's live update, instead of having the
client poll `GET /api/chats/:id/usage`, is both the simpler implementation
and a second, distinct demonstration of the Agents SDK lesson beyond
`onChatMessage()` streaming.

- **`ChatAgent`'s `State` type** (per Spike A's confirmed merge semantics
  and any internal `AIChatAgent` state usage it must coexist with) gains a
  `usage: ChatUsageSummary` field: `{ totalCostUsd, totalPromptTokens,
  totalCompletionTokens, turnCount, confirmedTurnCount, lastUpdatedAt }` —
  an **aggregate projection**, not a duplicate ledger. D1's `chat_usage`
  table (Section 6.4) remains the single source of truth for the numbers
  themselves and for anything that must be queried across chats (Phase 7's
  admin reports, Phase 12's exports); `state.usage` exists only to give the
  currently-connected client (and any client that connects later) an
  always-current, push-delivered summary of that same chat's own rows,
  without a round trip.
- **A shared `refreshUsageState()` helper**, called from both `onFinish`
  (Phase 6, immediately after the `estimated` row insert) and
  `reconcileUsage()` (after a successful `UPDATE`), re-aggregates this
  chat's `chat_usage` rows from D1 (`SUM(cost_usd)`, `SUM(prompt_tokens)`,
  `SUM(completion_tokens)`, `COUNT(*)`, `COUNT(*) FILTER (cost_source =
  'gateway')`) and calls `this.setState({ usage: {...} })` with the fresh
  aggregate. Recomputing from D1 rather than incrementally patching two
  separate running totals (one in `onFinish`, one in `reconcileUsage`) keeps
  D1 the only place the arithmetic happens — `state` is derived, never
  independently mutated.
- **Every `setState()` call is delivered to every currently-connected
  client automatically**, and — just as importantly — is what a client
  receives when it **connects** to a chat it was not already viewing. A
  turn reconciled while the user was looking at a different chat is
  already reflected the next time they open this one; no separate fetch is
  needed for that number specifically.
- **`broadcast()` complements `setState()` for the reconciliation
  transition specifically**, rather than replacing it: right after
  `reconcileUsage()`'s `setState()` call, broadcast a small
  `{ type: "usage_reconciled", chatUsageId, costSource: "gateway" }`
  message (or `{ type: "usage_reconcile_exhausted", chatUsageId }` if the
  bounded retry count was exhausted, Section 11) to currently-connected
  clients. `setState()` alone would update the number correctly, but a
  client cannot tell "the number changed because a new turn happened" from
  "the number changed because an estimate was just confirmed" by diffing
  state alone; the broadcast event exists purely so the UI can animate that
  specific badge flip (Estimated → AI Gateway) instead of a generic
  re-render. The initial `estimated` write in `onFinish` needs no broadcast
  of its own — there is no prior number to distinguish it from.
- **The Vue composable (`useChatAgent`, Section 6.2a/Phase 2) is the one
  place both mechanisms are consumed**: it exposes `state` as a reactive
  ref (updated whenever the underlying `AgentClient` reports a state
  change) and a typed event stream for broadcast messages. The chat
  header's cost badge component reads `state.usage` reactively for its
  numbers and its "AI Gateway"/"Estimated" mix, and listens for the
  `usage_reconciled`/`usage_reconcile_exhausted` broadcast only to trigger
  the transition animation.
- **This live-push mechanism covers the currently-open chat only.** The
  sidebar (Phase 3) lists potentially many chats at once and does not hold
  a live connection to every one of them, so its per-entry cost figures
  remain REST-driven (`GET /api/chats`, reading the same D1 aggregate),
  refreshed after each mutation exactly as Phase 3 already does for
  titles. This is a deliberate, documented asymmetry, not an oversight:
  push where a live connection already exists and the data is the point of
  this phase's lesson; REST where fetching N chats' worth of state over N
  WebSocket connections would be the wrong tool.

Every cost/token figure this produces — whether freshly pushed via
`setState()`, received on connect, or read from the sidebar's REST call —
renders the same "AI Gateway"/"Estimated" badge distinguishing
`cost_source = 'gateway'` from `cost_source = 'estimated'` rows, paired
with a confirmation-ratio summary (for example "3 of 4 turns confirmed by
AI Gateway") so the mix is legible rather than presenting a single number
of ambiguous provenance. Phase 7's admin reports inherit the same per-row
`cost_source` and surface an account-wide confirmation ratio for the same
reason.

AI Gateway's own cost-analytics dashboard remains the **operator-facing**
cross-check in `DEMO.md` — a second place to *see* the same authoritative
numbers this ledger already stores, not a second place the application
*computes* them from. This is also, not incidentally, exactly the number
AI Gateway's own spend limits (Phase 8) enforce against: Phase 7's admin
reports and Phase 8's spend-limit behavior are reading and bounding the
same authoritative figure, not two independently-derived ones.

### 6.7 `getUrl` Egress Control: Dynamic Workers, Not VPC/Gateway Or Sandbox SDK

The backlog names this tool's requirement as "goes through egress control"
and explicitly invites considering either the Sandbox SDK or "Dynamic
Workers (Cloudflare service)". This plan chooses **Dynamic Workers**
(the `worker_loaders` binding and its `globalOutbound` egress-control
option), for reasons distinct from why the Sandbox SDK was rejected in the
prior revision of this plan:

- **It is Workers-native and isolate-level, not container-level.** Dynamic
  Workers are explicitly documented as "a lightweight alternative to
  containers for securely sandboxing code you don't trust" — no Docker
  dependency for local development, no container billing, and (per Spike C)
  no dependency on a Cloudflare Mesh/Tunnel network or a Zero Trust
  Gateway policy, which the previously-considered Workers VPC `EGRESS`
  binding would have required standing up. This is meaningfully simpler
  infrastructure for a single tool's outbound `fetch()`.
- **The `globalOutbound` model is exactly this tool's shape.** Rather than
  giving the agent's tool code a raw `fetch()` and trying to constrain it
  after the fact, the tool's fetch runs **inside a cached Dynamic Worker**
  (`env.LOADER.get("get-url-tool", ...)`, loaded once and kept warm — the
  code it runs never changes, so `get()` is correct, not `load()`) whose
  `globalOutbound` is bound to an `EgressGateway` `WorkerEntrypoint`
  defined in the main Worker script. Every outbound request the sandboxed
  fetch makes is intercepted by that gateway, which allow-lists hostnames,
  logs every attempt (allowed and blocked) via `cloudflareLogger()`, and can
  attach a per-request identity (`ctx.props`) for scoping/auditing without
  ever exposing a secret to the sandboxed code path. This is a strictly
  better teaching example of "deny by default, permit deliberately" than
  application-level URL validation alone, and it directly reuses the
  primitive Cloudflare's own docs recommend for "custom tools that execute a
  task, call an integration, or automate a workflow" — precisely this
  tool's job.
- **It does not duplicate demo 8's lesson.** Demo 8 (`demos/opencode`) is
  the container/Sandbox-SDK lesson: a full Linux environment for an
  arbitrary, heavier workload. Dynamic Workers is a distinct point on the
  sandboxing spectrum (isolate-level, narrow-purpose), so choosing it here
  keeps the two demos non-overlapping rather than merely "the other
  container option."
- **`writeMarkdown` deliberately does *not* run through a Dynamic Worker.**
  It has no untrusted network egress to control — it writes model-generated
  text to R2 through a binding the main Worker already trusts. Routing it
  through a sandbox would add ceremony with no corresponding security
  benefit; only `getUrl`'s genuine egress boundary earns the extra
  mechanism. This asymmetry is deliberate and should be called out in
  `EXPLAIN-DEMO.md`, not "fixed" for consistency.

Spike C (Section 8) confirms the mechanics before Phase 10 is built:
whether a Durable Object (the `ChatAgent` instance calling the tool) can use
a `worker_loaders` binding declared on the same Worker script, the exact
`ctx.exports.EgressGateway()` wiring, whether `@cloudflare/vitest-pool-workers`
supports `worker_loaders` locally for integration tests, and confirmation
that the demo account is provisioned on a Workers Paid plan (Dynamic
Workers' current plan requirement).

## 7. Alternatives Considered

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| Chat coordination primitive | `AIChatAgent` (Agents SDK) | Hand-rolled `DurableObject` (as in demo 4) | The lesson here is the Agents SDK itself; hand-rolling would re-teach demo 4 and skip the SDK's persistence/streaming/tool-loop integration. |
| Model selection surface | AI Gateway dynamic routes | Client-visible model dropdown (as in demo 5) | Demo 5 already taught raw model comparison; this demo's lesson is *governed* routing, which requires the decision to live server/platform-side. |
| Egress control for `getUrl` | Dynamic Workers (`worker_loaders` binding, `globalOutbound` gateway) | Sandbox SDK / Containers; Workers VPC `EGRESS` binding + Zero Trust Gateway policy | Avoids a Docker-dependent local dev story and duplicating demo 8's container lesson; avoids standing up a Cloudflare Mesh/Tunnel network or a Zero Trust Gateway policy for one tool's outbound fetch; `globalOutbound` is purpose-built for exactly this "intercept, allow-list, log, inject credentials" shape. |
| Skills mechanism | Hand-rolled skill catalog + R2 storage, informed by the experimental `@cloudflare/think` Agent Skills shape (pending Spike D) | Adopt `@cloudflare/think`'s `Think` class wholesale | `Think` is a different, higher-level chat agent class than `AIChatAgent`; switching base classes to get skills would drop the WebSocket-based `AIChatAgent` mechanism the backlog explicitly asks for. If Spike D finds the experimental package composable with `AIChatAgent` directly, prefer it over the hand-rolled version and update this row. |
| Cost source of truth | AI Gateway's own logged cost via `getLog()`, fetched asynchronously and reconciled into the ledger; local pricing-table computation is an immediate, visibly-labeled fallback only (pending Spike F) | Local pricing-table computation as the sole/primary source | `getLog()` is Cloudflare's own authoritative, billing-grade number, not an estimate this demo invents; a local-only estimate would let the "AI Gateway cost controls" lesson the backlog names go untaught. The trade-off — an asynchronous reconciliation step and a two-state UI indicator — is accepted because both are true to how the platform actually reports cost. |
| Cost UI update mechanism | `ChatAgent`'s own `setState()` (for the durable, reconnect-safe running total) plus `broadcast()` (for an ephemeral reconciliation-transition event) — Section 6.6a | Client-side polling of `GET /api/chats/:id/usage` | Reuses capabilities `ChatAgent` already has as an Agents SDK `Agent`, needs no poll interval to tune, delivers the update the instant reconciliation completes, and — via `state` hydration on connect — is already correct for a client that opens the chat after the fact, which a poll-on-open would also need to handle as a special case anyway. |
| Admin representation | D1 `is_admin` flag + application middleware | A second Cloudflare Access application/policy for admin routes | Access has no concept of this demo's role; role-based authorization is correctly an application-layer concern per AGENTS.md's separation-of-concerns guidance. |
| Third-party model providers | Excluded | Allow AI Gateway to proxy OpenAI/Anthropic/etc. | Keeps this demo's credential surface identical to demo 5 (Workers AI only); adding BYOK here would mix a secrets-management lesson into a routing lesson. |

## 8. Spike Conventions

Spikes live in a top-level **`spikes/`** directory (a sibling of `demos/`,
never inside it). A spike is disposable-quality, committed code whose sole
purpose is to answer one stated question against the real Cloudflare
account — it is **not** a demo and is exempt from most of the demo contract
in AGENTS.md: no custom domain, no `DEMO.md`/`EXPLAIN-DEMO.md`, no
three-Vitest-project structure, and a `README.md` that states the spike's
aim rather than operator instructions. It is **not** exempt from Terraform
or from Cloudflare Access, for the account-specific reason below.

### This Cloudflare account requires every Worker to sit behind Access

This account's Zero Trust/SASE posture requires **every** Worker reachable
over HTTPS — including a bare `*.workers.dev` URL, not only a custom
domain — to be fronted by a Cloudflare Access self-hosted application and
policy. There is no exception for a throwaway spike: a deployed Worker with
no Access application in front of it is simply unreachable, and a spike
that tried to skip this step would not be testing the platform, it would be
testing a `403` from Access. Concretely, this changes the earlier blanket
"no Terraform, no Access" framing above to a narrower, still-simple rule:

- **A spike that never exposes an inbound HTTPS endpoint** (pure
  `wrangler dev`/`vitest-pool-workers` work against local or remote
  bindings, with no deployed, publicly reachable Worker) needs neither
  Terraform nor an Access application. Access enforcement happens at
  Cloudflare's edge in front of a deployed Worker's public hostname; it has
  nothing to enforce against a local dev server — `wrangler dev`/`vite dev`
  serve the Worker's own inbound HTTP interface locally even when a
  binding (`AI`, a Worker Loader) is proxied to the real account remotely,
  exactly as demo 5's "Workers AI Has No Local Simulation" section already
  established for `env.AI`. Several of this demo's spikes can likely stay
  entirely in this category; each spike's own aim should say explicitly
  whether it needs a real deployment, rather than assuming one either way.
- **A spike that deploys a Worker and exercises it over its own public
  hostname** (verifying real end-to-end HTTP/WebSocket behavior that local
  dev cannot faithfully simulate) MUST front that Worker's hostname with a
  Cloudflare Access self-hosted application and a **bypass-all** policy —
  the same `decision = "bypass"` /
  `include = [{ everyone = {} }]` shape AGENTS.md's Public Access section
  already establishes for a normal public demo. A bypass policy issues no
  identity JWT and requires no login, which is exactly what a spike's own
  `curl`/test script needs: it can hit the endpoint directly with no Access
  authentication dance of its own to build.
- **Reuse the root `.env`'s credentials** for whichever mechanism creates
  this Access application — the same `CLOUDFLARE_API_TOKEN`/
  `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_TEAM_DOMAIN` a demo's Terraform reads
  via the `dotenv` provider. A spike does not need its own token.

Two mechanisms are equally sanctioned for creating (and, critically,
tearing down) this bypass application; pick whichever is simpler for a
given spike and say which one in that spike's `README.md`:

1. **A minimal, spike-scoped Terraform config** (`spikes/<NN>-<slug>/infra/`,
   a single `main.tf` reusing the `dotenv` provider against the repo root
   `.env`) declaring only what that spike needs — typically the Access
   application/policy and, if the spike wants Terraform to own the Worker
   too, the Worker resource itself. This is real Terraform state for a
   throwaway resource, which is a fine trade: `terraform destroy` tearing
   down exactly what `terraform apply` created is more reliable than a
   hand-written cleanup checklist, and this repo already has every
   Terraform pattern (the `dotenv` provider, the bypass-policy snippet) to
   copy from verbatim.
2. **The `cf` unified CLI** (`npx cf`, an official Cloudflare technical
   preview covering Workers and Zero Trust with one consistent tool —
   confirm current command names with `cf --help`/`cf access --help`
   before relying on specifics here, since it is actively evolving). `cf`
   resolves `CLOUDFLARE_API_TOKEN` from the environment exactly like the
   root `.env` already provides, needs no state file, and is the lighter
   choice when a spike wants to create and delete one Access application
   and policy imperatively without carrying a Terraform config for
   something this ephemeral.

Whichever mechanism a spike uses, its `README.md` MUST document the exact
create and teardown steps, and its "clean up every spike's real-account
footprint" pass (below) MUST tear the Access application and policy down
alongside every other resource the spike created — an orphaned bypass
policy is a stray, unaudited hole in this account's Access posture, not a
harmless leftover.

Each spike is its own directory, `spikes/<NN>-<slug>/`, and MUST contain:

- A short `README.md` stating the spike's **aim** (the exact question being
  answered) up front, before any code walkthrough, plus — for any spike
  that deploys a Worker — exactly how its Access application/policy was
  created and how to tear it down.
- The minimal code needed to answer that question — a `wrangler.jsonc`
  targeting `*.workers.dev` (no custom domain needed; Access can front a
  `workers.dev` hostname directly, so a spike never needs the DNS/zone
  overhead of a scratch custom domain), a handful of source files, and — for
  a spike with no inbound HTTPS endpoint — credentials read directly by a
  small script or `wrangler dev --remote` rather than provisioned by
  anything.
- A `REPORT.md` written **after** running the spike, stating exactly what
  was observed (real request/response shapes, exact config keys, error
  messages verbatim, version numbers) — not what was expected. Corrections
  to a prior assumption are exactly as valuable a finding as a confirmation.

**Do not write tests for a spike unless the test is what runs the spike.** A
spike is answered by executing it against the real account and reading the
result, not by a mocked unit test asserting an assumption about how the
platform behaves — that would defeat the spike's purpose. Where a spike's
only reasonable way to exercise the real platform *is* a Vitest test (for
example, an integration test hitting a real remote binding with
`remoteBindings: true`), that one test **is** the spike; do not additionally
write mock-based unit tests beside it.

Every spike ends with two required feedback actions, done as part of the
spike's own commit:

1. **Update this document** (`docs/06-AGENTIC-CHAT.md`) wherever the spike
   confirmed, corrected, or replaced an assumption — the same discipline
   `docs/05-AI-CHAT.md` used for its model-catalog spike corrections.
2. **Append an entry to `docs/DECISIONS.md`** under "NEW DECISIONS", in the
   same style as existing entries (a title, what was tested, what was found,
   and what future demos should reuse rather than rediscover). Any spike
   that stood up an Access application should record which of the two
   mechanisms above it used and how well it worked, so later spikes do not
   have to re-decide this.

Clean up every spike's real-account footprint immediately after writing its
report: `terraform destroy` (if Terraform was used) or the equivalent `cf`
delete commands for the Access application/policy, `wrangler delete` any
deployed Worker, and manually remove any AI Gateway, dynamic route, or
Gateway policy resource the spike created that Terraform will not later
own. A spike's code stays in the repo for traceability; its billable and
Access-application footprint does not outlive the spike.

## 9. Implementation Plan

Tag format: `agentic-chat/phase-<NN>-<slug>`, applied to the commit that
completes each phase, after formatting/linting/type-checking/tests/build/
`terraform fmt -check`/`terraform validate` all pass. This lets any two
phases be diffed directly (`git diff agentic-chat/phase-02-core-chat
agentic-chat/phase-03-chat-management`).

### Phase 0 — Spikes (tag: `phase-00-spikes`)

No feature code. Spikes A–E are independent and may be run in any order.
Spike F depends on A and B's findings and should run after them. All must
land before Scaffolding begins, since Scaffolding's Wrangler config and
Terraform depend on their findings.

**Spike A — `AIChatAgent` + Workers AI + AI Gateway, end to end.**
*Aim*: prove the minimal working chain: a `@cloudflare/ai-chat` `AIChatAgent`
subclass, one Durable Object per chat name, `onChatMessage` calling the `ai`
SDK's `streamText()` with `workers-ai-provider`'s `createWorkersAI({
binding: env.AI })`, a model routed through an AI Gateway binding
(`gateway: { id }`), streamed to a browser over WebSocket. Confirm: exact
package versions compatible with this repo's Node 24/TypeScript 6 baseline;
the exact `wrangler.jsonc` shape (durable object binding +
`new_sqlite_classes` migration + `ai` binding + `nodejs_compat`); whether
`workers-ai-provider` absorbs the per-model streaming-shape differences demo
5 had to hand-roll (confirm across at least one reasoning and one
non-reasoning model from demo 5's verified catalog, and record whether
reasoning content surfaces as a distinct message part); how a chat is
named/instanced (confirm `routeAgentRequest` default routing vs. a custom
`getAgentByName(chatId)` call site, since the backlog requires per-topic,
not per-user, instancing); and whether/how a verified Access identity can be
threaded into the agent so it never trusts a client-supplied owner.

**The Agents SDK's own documented client hooks (`useAgent`/`useAgentChat`
from `agents/react`) are React-specific**, but AGENTS.md mandates Vue 3 for
every demo's browser UI. Confirm that the underlying client transport
(`AgentClient`, per the Agents SDK's client-side API reference) is itself
framework-agnostic — a plain WebSocket client the React hooks wrap, not
something React-coupled — so this demo can build its own thin Vue composable
(`src/client/composables/useChatAgent.ts`, following the pattern in this
repo's `create-adaptable-composable` skill) directly on top of it for both
message streaming and state sync (Section 6.6a), instead of reimplementing
the Agent WebSocket protocol from scratch. Also confirm `setState()`'s
merge semantics (a full state replacement or a shallow/deep merge with the
previous state) and whether `AIChatAgent` itself already occupies any part
of the `State` generic internally (for message history or otherwise) that a
custom `State` shape added by this demo (Section 6.6a) must coexist with
rather than accidentally clobber. *Report*: the minimal working example,
exact versions, the confirmed Vue-composable-over-`AgentClient` pattern, the
confirmed `setState()` merge semantics, and every gotcha found around
Durable Object hibernation/eviction interrupting an in-flight stream.

**Spike B — AI Gateway provisioning and dynamic routes as infrastructure.**
*Aim*: determine how much of the AI Gateway configuration this demo needs
(the gateway itself, the two dynamic routes, their conditional/rate-limit/
spend-limit nodes) can be created and versioned through Terraform (check the
pinned `cloudflare/cloudflare ~> 5.22.0` provider schema for an AI Gateway
resource) versus what must be created through a small idempotent script
against the Cloudflare API — mirroring, if needed, the sanctioned
bootstrap-deployment exception's spirit (a documented, narrow, one-purpose
exception to "Terraform owns infrastructure," not a precedent for skipping
Terraform generally). Confirm the exact request shape for calling a route
(`dynamic/<name>` in place of a model, through which endpoint — the
OpenAI-compatible endpoint, or the `gateway.id` + model-string form
documented for `env.AI.run()`), the exact conditional-expression syntax for
branching on custom metadata (`metadata.business == "leadership"` or
otherwise), and how to read back a turn's real cost (`env.AI.gateway(id)
.getLog(logId)` vs. relying solely on local pricing-table computation, per
Section 6.6). *Report*: the concrete provisioning mechanism chosen (with the
exact Terraform resource names if any exist, or the exact script this repo
will run and when), the verified route JSON schema, and the verified
conditional-expression syntax.

**Spike C — Dynamic Workers as the egress-control mechanism for the `getUrl`
tool.**
*Aim*: prove the minimal working `globalOutbound` gateway pattern for a
single tool's outbound fetch. Confirm: the demo Cloudflare account is (or
can be put) on a **Workers Paid plan** (Dynamic Workers' current plan
requirement — if this is a hard blocker for how this demo is normally
deployed, that must be escalated and resolved before Scaffolding, not
discovered mid-Phase-10); the exact `worker_loaders` binding declaration and
whether a Durable Object (`ChatAgent`) sharing the main Worker script's
`env` can call `env.LOADER.get()`/`.load()` the same as the top-level
`fetch()` handler could; the exact `ctx.exports.EgressGateway()` wiring for
passing a `WorkerEntrypoint` gateway class as `globalOutbound`, including
whether `ctx.exports` is available from inside a Durable Object method or
must be threaded in from the Worker's own `fetch()` call site; a working
allow-list gateway that blocks a non-allow-listed host and permits an
allow-listed one, with both outcomes logged; and whether
`@cloudflare/vitest-pool-workers` supports `worker_loaders` locally for
integration tests (a real network fetch inside a test is undesirable
regardless — confirm whether the gateway itself, independent of `fetch()`,
is unit-testable by injecting a fake `fetch` into the `EgressGateway`
class). *Report*: the exact wiring pattern that worked, any restriction
found on calling it from a Durable Object versus the top-level Worker, and
the confirmed plan/billing prerequisite to document in `README.md`. If any
part of this proves unworkable (for example, if `worker_loaders` cannot be
reached from the `ChatAgent` Durable Object at all), the fallback is the
Sandbox SDK after all, in which case Section 6.7 and Phase 10 must be
rewritten before Phase 10 starts.

**Spike D — Skills mechanism compatible with `AIChatAgent`.**
*Aim*: determine whether the Agents SDK's released **Agent Skills**
(`@cloudflare/think`'s `agents:skills` import, `skills.r2()`,
`activate_skill`/`read_skill_resource`/`run_skill_script` tools — currently
marked experimental) can be attached to an `AIChatAgent`-based chat (which
drives its own `ai` SDK `streamText()` call rather than `Think`'s internal
loop), or whether it is `Think`-only. If it is composable, prove a minimal
example loading one R2-backed skill into an `AIChatAgent` tool set. If it is
not composable, design and prove a minimal hand-rolled equivalent: an
`activateSkill(name)` tool exposed to `streamText()`'s `tools`, backed by a
skill catalog (name + one-line description only) injected into the system
prompt, with full skill content (a `SKILL.md`-shaped Markdown file, plus any
resource files) fetched from R2 on demand only when the model activates it —
mirroring the experimental feature's "catalog in the prompt, content on
demand" shape closely enough that this demo can adopt the real feature later
with minimal rework. *Report*: the decision (adopt vs. hand-roll) and the
minimal proof-of-concept shape either way, since Phase 11 is written against
this finding.

**Spike E — Workers AI speech-to-text.**
*Aim*: confirm the exact input contract for a Workers AI speech-to-text
model (`@cf/openai/whisper-large-v3-turbo` or `@cf/deepgram/nova-3`) called
via `env.AI.run()` or `workers-ai-provider`'s `experimental_transcribe()` —
required audio encoding/format, base64 vs. binary input, maximum duration,
and the exact output shape. Confirm a browser's `MediaRecorder` default
output (typically `audio/webm;codecs=opus`) is accepted directly or needs
client-side conversion, and record realistic latency for a roughly
10-second utterance. *Report*: the exact request/response shapes and the
client capture format this demo will use.

**Spike F — AI Gateway cost/log reconciliation.**
*Aim*: determine exactly how this demo reads back a completed turn's
authoritative cost and token counts, since Section 6.6 makes that the
ledger's preferred source rather than the local pricing-table fallback.
Run this spike after Spikes A and B, reusing their harnesses, since the
answer depends on both: whether the model is called via `env.AI.run()`
directly or only reachable by name through `workers-ai-provider`'s
`streamText()` integration (Spike A), and whether a **dynamic route**
name (`dynamic/agentic-chat-basic`) can be passed as the `model` argument
to the `AI` binding at all, or whether calling a dynamic route requires the
OpenAI-compatible HTTP endpoint instead — in which case log-ID retrieval
may work differently than the binding's `env.AI.aiGatewayLogId` (Spike B).
Confirm: whether `env.AI.aiGatewayLogId` is populated correctly after a
`streamText()` call made through `workers-ai-provider`'s binding adapter,
and precisely *when* during the stream lifecycle it becomes readable (at
`run()`'s resolution, which per demo 5's finding returns the stream object
almost immediately, or only once the stream is fully drained); whether
reading `aiGatewayLogId` is safe when more than one `env.AI` call could be
in flight within the same Durable Object around the same time (for example
Phase 3's auto-title generation running close to the main turn) or whether
the demo must serialize such calls to avoid one call's log ID clobbering
another's; the exact shape of `getLog()`'s response (field names for
prompt/completion tokens and USD cost, and what a "not yet available"
response looks like — absent field, `404`, or a defined pending state); and
the real-world lag between a turn completing and `getLog()` returning
populated cost data, which sets Phase 6's reconciliation delay/backoff
schedule. *Report*: the exact call path this demo will use to obtain a log
ID, the confirmed `getLog()` response shape, the measured reconciliation
lag (and therefore the chosen `this.schedule()` delay/backoff), and whether
any AI call serialization is required within `ChatAgent` to keep log-ID
capture reliable.

### Phase 1 — Scaffolding (tag: `phase-01-scaffolding`)

Baseline infrastructure and repo skeleton only — no chat feature yet, but the
app must build, deploy, and pass Access sign-in end to end.

1. Create `demos/agentic-ai-chat` following the canonical `demos/url-shortener`
   layout (`infra/`, `src/worker/`, `src/client/`, `tests/integration/`,
   `.env.example`, `README.md`, `DEMO.md`, `EXPLAIN-DEMO.md`, `biome.json`,
   `tsconfig.json`, `vite.config.ts`, root `vitest.config.ts`), Vue 3 +
   Vuetify + Pinia + Vue Router + Feather Icons + Hono + TypeScript.
2. Provision baseline Terraform: a Worker (explicit `subdomain` block), the
   `agentic-chat.cfapps.uk` custom domain (with the sanctioned bootstrap
   version/deployment for `cloudflare_workers_custom_domain`), a D1 database,
   Workers Logs, and automatic tracing with explicit sampling. Provision
   Spike B's AI Gateway resource(s) to whatever extent Spike B found
   Terraform-manageable. Read configuration from `../.env` via the `dotenv`
   provider; `DEMO_NAME=agentic-chat`, `DEMO_DOMAIN=cfapps.uk`.
3. Provision one Cloudflare Access self-hosted application covering the
   whole hostname, backed by an `allow` policy requiring authentication
   (no bypass), with `audience` set (Section 6.5) — following
   `demos/todo-app`/`demos/chat`.
4. Commit `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value; bind D1 as `DB`; declare `nodejs_compat`
   (required by the Agents SDK per its own configuration guidance) and a
   current `compatibility_date`; declare `"ai": { "binding": "AI",
   "remote": true }` (demo 5's finding, Section "Workers AI Has No Local
   Simulation" reused verbatim — see `docs/DECISIONS.md` #9); configure
   `assets` with `single-page-application` fallback and `run_worker_first:
   ["/api/*", "/agents/*"]` (or whatever routing prefix Spike A's chat
   Durable Object actually uses). Do **not** yet declare the Agent's own
   Durable Object binding/migration — that lands in Phase 2 alongside the
   code that needs it, so this phase's diff is pure scaffolding. Commit
   `infra/local-outputs.json`, wire `generate-wrangler -c -l
   infra/local-outputs.json` into every hook AGENTS.md specifies
   (`prebuild`, `prestart`, `precheck:types`, `pretest`,
   `pretest:coverage`, `pretest:integration`). Commit a `.dev.vars` (no
   secrets) setting local `ENVIRONMENT`.
5. Define the initial D1 migration: `users` (`email` PK, `is_admin` default
   `0`, `created_at`) and `chats` (`id` PK, `owner_email`, `title`, `route`,
   `created_at`, `updated_at`). Run through `db:migrate:remote`/
   `db:migrate:local` (`CI=1`, explicit `--remote`/`--local`).
6. Mount `cloudflareAccess()` globally; derive identity from the verified
   JWT only, never client input. Add `src/access-policies.ts` (fail-safe:
   every entry `authenticate: true`), and `cloudflareAccessPlugin()` in
   `vite.config.ts` before `cloudflare()`, with selectable dev `users`.
   Implement `GET /api/me` and a shared `ensureUser(email)` upsert called
   after Access verification, plus the `ADMIN_EMAIL`-driven admin
   bootstrap (Section 6.5) as an idempotent step run on the same path.
7. Mirror `demos/chat`'s `package.json` script set (`build`, `check:*`,
   `format:*`, `generate:*`, `start`, `test*`, `db:migrate:*`, `deploy`,
   `teardown`), adding `preteardown` cleanup only for resources this phase
   actually provisions (R2's `empty-r2-bucket` step is deferred to whichever
   phase first provisions an R2 bucket).
8. Render a minimal "signed in as `{email}`" shell with a logout control and
   nothing else client-facing yet.

**Definition of done**: `npm run deploy` provisions a working, empty,
Access-gated shell; `npm test` passes with a `worker` project test for
`ensureUser`/admin-bootstrap logic and an `integration` project test proving
unauthenticated requests are rejected and `GET /api/me` returns the verified
identity. `terraform fmt -check`/`validate` pass.

### Phase 2 — Feature: Core Agentic Chat (US-1) (tag: `phase-02-core-chat`)

1. Add the Durable Object binding/migration for the `AIChatAgent` subclass
   (`ChatAgent`) per Spike A's findings; declare it alongside whatever
   packages Spike A pinned (`agents`, `@cloudflare/ai-chat`, `ai`,
   `workers-ai-provider`).
2. Implement `src/worker/agent/chat-agent.ts`: `ChatAgent extends
   AIChatAgent<Env>`, `onChatMessage` calling `streamText()` with a single
   hard-coded Workers AI model routed through the AI Gateway binding (defer
   the two dynamic routes to Phase 4 — this phase proves the mechanism with
   the simplest possible model wiring). Persist nothing beyond what the SDK
   already persists.
3. Implement chat instancing: a `POST /api/chats` route creates a new chat
   ID, inserts its D1 directory row (`owner_email` = verified identity), and
   returns the ID the client uses to open a connection against that instance
   name. A request routed to a chat ID whose D1 row's `owner_email` does not
   match the verified identity is rejected with `404` (not `403`, to avoid
   confirming another user's chat ID exists).
4. Implement `src/client/composables/useChatAgent.ts`, per Spike A's
   confirmed pattern: a Vue composable wrapping `AgentClient` directly
   (framework-agnostic, not `agents/react`) that exposes reactive refs for
   the message stream, connection status, and the agent's synced `state`
   (Section 6.6a), plus a `send()` method. This is the **one** place the
   Agent WebSocket protocol is spoken; every store/component consumes the
   composable, never the raw client.
5. Build the composer + streaming transcript UI (Vuetify, Cloudflare
   palette, Feather Icons, WCAG 2.2 AA) on top of `useChatAgent`:
   submit-on-enter, streaming answer text, an activity indicator between
   submit and first token honoring `prefers-reduced-motion`.
6. Manage session/chat state in Pinia (`session`, `chat` stores, the latter
   backed by `useChatAgent`); `src/client/main.ts` bootstrap-only, `App.vue`,
   `views/`.

**Testing**: `worker` project — chat-ownership check, D1 chat-directory
repository. `client` project — composer submit/clear, streaming transcript
rendering, activity indicator lifecycle (mocked WebSocket). `integration`
project — creating a chat, sending a message end to end against a real
Durable Object with a fake/injected model (following demo 5's "inject a fake
`Ai`" pattern, adapted for `workers-ai-provider`'s binding shape), and
ownership rejection for a foreign chat ID, unauthenticated rejection on both
`POST /api/chats` and the agent WebSocket upgrade.

**Definition of done**: a signed-in user can create one chat and hold a
real, streamed, multi-turn conversation end to end against the deployed
account.

### Phase 3 — Feature: Chat Sidebar And Management (US-2) (tag: `phase-03-chat-management`)

1. `GET /api/chats` lists the signed-in user's chats (D1, most-recently-
   updated first); `DELETE /api/chats/:id` removes the directory row and
   tears down the chat's Durable Object state (an RPC method on `ChatAgent`,
   mirroring demo 4's `destroy()` pattern).
2. Auto-title: after a chat's first completed turn, generate a short title
   (a cheap, additional Workers AI call, or model-provided summary via the
   same `streamText()` call with a title-generation instruction) and persist
   it to the D1 `chats.title` column; update `updated_at` on every turn so
   the sidebar orders by recency.
3. Sidebar UI: "+ New Chat", the chat list with titles, a per-chat delete
   control, the active chat highlighted; deleting the currently open chat
   returns the user to a remaining chat or an empty state.
4. `chats` Pinia store owns list/create/delete/select, refreshing after each
   mutation.

**Testing**: `worker` — title-generation trigger logic (given a completed
turn, produce/persist a title), delete cascading to Durable Object teardown.
`client` — sidebar rendering, new/select/delete interactions,
currently-open-chat-removed redirect behavior. `integration` — full
create→chat→auto-title→list→delete lifecycle; a user cannot list, load, or
delete another user's chat.

**Definition of done**: multi-chat management works end to end with correct
per-user isolation.

### Phase 4 — Feature: Governed Model Selection Via Dynamic Routes (US-3) (tag: `phase-04-dynamic-routes`)

1. Per Spike B, provision (Terraform and/or the chosen script) the AI
   Gateway and its two dynamic routes, `agentic-chat-basic` and
   `agentic-chat-reasoning`, each with a single model node initially (no
   business-metadata conditional yet — that is Phase 8): basic → a
   non-reasoning model from demo 5's verified catalog (for example Granite
   4.0 H Micro); reasoning → a reasoning model (for example DeepSeek R1
   Distill Qwen 32B). Commit the route definitions as versioned JSON under
   `infra/ai-gateway-routes/`.
2. Replace Phase 2's hard-coded model call with a route selector: the client
   sends `"basic"` or `"reasoning"` (never a model ID); the Worker maps that
   to the dynamic route name server-side before calling `streamText()`,
   exactly mirroring demo 5's "the Worker resolves by exact match, never
   interpolates a client-supplied string into a model ID" rule, applied to
   route names instead of model IDs.
3. Persist the selected route on the `chats.route` column (selectable only
   when a chat has no turns yet, mirroring a real product's "can't switch
   models mid-thread" affordance — or allow mid-chat switching if simpler;
   record the decision either way in `EXPLAIN-DEMO.md`).
4. UI: replace any temporary model text with a two-option dropdown ("Basic",
   "Reasoning"), defaulting to "Basic".

**Testing**: `worker` — route-name resolution/rejection of anything else.
`client` — dropdown renders exactly two options, selection persists.
`integration` — a request naming an invalid route is rejected before any
model call; both real dynamic routes are exercised end to end against the
deployed AI Gateway (this phase's integration coverage necessarily touches
the real account for this one behavior, following demo 5's "Workers AI has
no local simulator" precedent — document this in `README.md`'s testing
section).

**Definition of done**: model choice is fully server/platform-governed; the
two routes are independently editable in the AI Gateway dashboard without a
Worker redeploy.

### Phase 5 — Feature: Voice-To-Prompt Dictation (US-4) (tag: `phase-05-speech-to-text`)

1. Per Spike E, implement `POST /api/transcribe` (multipart or raw body,
   per the spike's confirmed contract) calling the Workers AI speech-to-text
   model and returning `{ text }`.
2. Client: a microphone control using `MediaRecorder`, with clear
   permission-denied and transcription-failure states; on success, populate
   (never auto-submit) the composer.

**Testing**: `worker` — request validation (size/duration caps), response
shaping, error mapping (RFC 9457). `client` — mic control states (idle,
recording, transcribing, error), composer population without auto-submit
(mocked `MediaRecorder`/fetch). `integration` — the endpoint accepts a
scripted fixture through a fake AI binding, rejects unauthenticated
requests, rejects an oversized payload.

**Definition of done**: dictation reliably produces editable composer text
for a short utterance.

### Phase 6 — Feature: Per-Chat Cost And Token Visibility (US-5) (tag: `phase-06-cost-ledger`)

1. Add the `chat_usage` D1 migration (Section 6.4, including `cost_source`,
   `gateway_log_id`, `reconcile_attempts`) and `src/worker/usage/`
   repository, exposing separate `insertEstimated()`,
   `reconcileWithGatewayLog()`, and `aggregateForChat()` operations rather
   than one generic upsert, so each write/read path's intent is explicit
   and independently testable. `aggregateForChat()` is the single query
   `refreshUsageState()` (Section 6.6a) runs.
2. Extend `ChatAgent`'s `State` type with `usage: ChatUsageSummary`
   (Section 6.6a), per Spike A's confirmed `setState()` semantics. Implement
   the shared `refreshUsageState()` helper that calls `aggregateForChat()`
   and `this.setState({ usage: {...} })`.
3. In `ChatAgent`'s `onFinish` callback, per Spike F's confirmed call path:
   capture the turn's `aiGatewayLogId`; compute the immediate local estimate
   from `streamText()`'s reported usage and the static per-model pricing
   table; insert one `chat_usage` row (`cost_source = 'estimated'`) via
   `insertEstimated()`; call `refreshUsageState()` so the connected client
   (if any) sees the new total immediately. A turn that never reaches
   `onFinish` (aborted, errored pre-first-token) must not write a row or
   call `refreshUsageState()` — verify this explicitly in tests (Failure
   Modes, Section 11).
4. Implement `reconcileUsage(payload)` as an Agents SDK scheduled-task
   handler on `ChatAgent`: call `getLog(gatewayLogId)` per Spike F's
   confirmed response shape. On success: `reconcileWithGatewayLog()`,
   `refreshUsageState()`, then `this.broadcast({ type: "usage_reconciled",
   chatUsageId, costSource: "gateway" })` (Section 6.6a). On a
   not-yet-available result: increment `reconcile_attempts` and reschedule
   with backoff up to the bounded attempt count from Section 6.6. On
   exhausting that count: leave the row `estimated` and broadcast
   `{ type: "usage_reconcile_exhausted", chatUsageId }` so a connected
   client can settle any "still checking" UI state. If the row's chat/
   target no longer exists, exit without error and without broadcasting
   (Section 11). Schedule the first attempt from `onFinish` with
   `this.schedule()` using Spike F's measured initial delay.
5. `GET /api/chats` (the sidebar's directory listing, Phase 3) continues to
   read the same `aggregateForChat()`-shaped totals **and** per-chat
   `cost_source` mix from D1 for chats that are not the currently-open one
   (Section 6.6a) — this is the one deliberately REST-driven path in this
   phase, not an oversight relative to the live-push mechanism above.
6. UI: extend `useChatAgent` (Section 6.2a) to expose `state.usage`
   reactively and a typed handler for the two broadcast event types; build
   the chat header's live cost/token readout on top of it, with the "AI
   Gateway"/"Estimated" badge and an aggregate confirmation indicator (for
   example "3 of 4 turns confirmed") — animated on the broadcast events,
   correct even on first load from `state` hydration alone. The sidebar's
   per-chat figures (task 5) render the same badge language from their
   REST response.

**Testing**: `worker` — pricing-table computation (each model's rate),
estimated-row-per-completed-turn invariant, no-row-on-abort/error
invariant, `aggregateForChat()` correctness, `reconcileUsage()`'s success/
not-yet-available/exhausted-retries/target-deleted branches (each
independently testable against a fake `getLog()`), and that `setState()`/
`broadcast()` are called with the expected payloads for each branch (a
fake/spy `Agent` base, not a real WebSocket, per Spike A's confirmed
testing seam). `client` — `useChatAgent`'s `state.usage` reactivity, the
two broadcast event handlers, badge/confirmation-indicator rendering, and
that a client connecting fresh sees the correct totals from `state`
hydration alone (mocked `AgentClient`). `integration` — a full turn over a
real WebSocket connection produces exactly one `estimated` usage row
immediately **and** a `state` update the connected test client observes;
a simulated successful `getLog()` reconciliation flips the row to `gateway`
with its (deliberately different, so the test can distinguish the two)
reported numbers **and** delivers the `usage_reconciled` broadcast to the
connection; a simulated permanently-unavailable log leaves the row
`estimated`, exhausts the bounded retry count, and delivers
`usage_reconcile_exhausted`; an aborted turn produces zero rows and no
state update; a chat deleted between scheduling and reconciliation does
not error the scheduled task and does not broadcast to a now-nonexistent
connection.

**Definition of done**: every chat visibly and correctly tracks its own
cost; the ledger is provably exact against a scripted fake model's usage
numbers **and** a scripted fake `getLog()` response; a connected client
sees both the immediate estimate and the later reconciliation update
without reloading or polling, driven entirely by `setState()`/`broadcast()`;
the UI never presents an estimated figure as if it were AI-Gateway-confirmed.

### Phase 7 — Feature: Admin Cost/Metadata Console (US-6) (tag: `phase-07-admin-console`)

1. Add the `users.business`/`users.geo` `ALTER TABLE` migration (nullable;
   `business` ∈ `field`/`product`/`leadership`, `geo` ∈
   `emea`/`apac`/`americas` — enforce as an application-level enum, not a D1
   `CHECK` constraint, so a future value needs no migration).
2. Implement `requireAdmin()` middleware (Section 6.5) and mount it on every
   `/api/admin/*` route.
3. `GET /api/admin/users` — every user, `chat_usage` total cost joined in
   (summing every row regardless of `cost_source`, per Section 6.6 — always
   the best available number), ordered descending, alongside a per-user
   confirmation ratio (`gateway`-sourced rows ÷ total rows). `PATCH
   /api/admin/users/:email` — set `business`/`geo`. `GET
   /api/admin/reports/by-business` and `GET /api/admin/reports/by-geo` —
   aggregate cost with the same confirmation-ratio treatment.
4. UI: an admin-only route/view (gated purely by the `GET /api/me`
   response's `is_admin` flag hiding the entry point — the real enforcement
   is server-side `requireAdmin()`, never trust the client-hidden nav item
   alone), a ranked user-cost table, a metadata editor, and the two report
   views — each cost figure carrying the same "AI Gateway"/"Estimated"
   badge language established in Phase 6, so an admin never mistakes a
   still-reconciling total for a fully confirmed one.

**Testing**: `worker` — `requireAdmin()` behavior for admin/non-admin/
unauthenticated; aggregation query correctness. `client` — admin nav
visibility tied to `is_admin`, table/editor/report rendering.
`integration` — a non-admin gets `403` from every `/api/admin/*` route; an
admin can read all users' costs and mutate any user's metadata; a report
total matches the sum of its constituent `chat_usage` rows.

**Definition of done**: admin console fully functional and provably
authorization-safe against a non-admin identity.

### Phase 8 — Feature: Metadata-Driven Model Routing (US-7) (tag: `phase-08-metadata-routing`)

1. Per Spike B's confirmed conditional-expression syntax, extend both
   dynamic routes with a conditional node branching on the caller's
   `business` metadata, choosing among two-to-three model nodes per route
   (for example: basic → leadership/product get a stronger non-reasoning
   model, field gets the cheapest; reasoning → leadership/product get a
   stronger reasoning model, field gets a cheaper one). Document the exact
   mapping (subject to re-verification against the live catalog, exactly as
   demo 5's catalog required) in `EXPLAIN-DEMO.md`, not only in Terraform/
   route JSON.
2. The Worker attaches the caller's `business` (read from D1, never from
   client input) as AI Gateway custom metadata on every chat request.
3. Optionally add a rate-limit and/or spend-limit node per Spike B's
   findings, scoped by the same metadata dimension, to make the "cost
   controls" half of the backlog's "Introduces" list observable, not just
   the routing half. Note in `EXPLAIN-DEMO.md` that any such limit is
   enforced against the same authoritative per-request cost AI Gateway
   reports through `getLog()` (Section 6.6) that Phase 6/7's ledger and
   admin reports already display — one number, enforced and reported
   consistently, not two independently-derived ones.

**Testing**: `worker` — metadata attachment (business is read server-side,
never trusted from the request body). `integration` — two chats from users
with different `business` values, otherwise identical requests, are
observed (via AI Gateway logs or a fake gateway double, per what Spike A/B's
test harness established) to select different models.

**Definition of done**: the same "Basic"/"Reasoning" client selection
resolves to different real models depending on the caller's business
metadata, with zero client-side branching.

### Phase 9 — Feature: Tool — Write A File To My Chat (US-8) (tag: `phase-09-write-markdown-tool`)

1. Provision an R2 bucket via Terraform (first R2 use in this demo; add the
   `empty-r2-bucket` `preteardown` step now, per AGENTS.md's R2 teardown
   convention).
2. Add the `chat_files` D1 migration.
3. Implement a `writeMarkdown` tool (Zod-validated input: filename,
   Markdown content) exposed in `ChatAgent`'s `streamText()` `tools`. On
   invocation: validate/sanitize the filename, write to R2 under a
   chat-scoped key, insert a `chat_files` row, and return a tool result the
   model can reference in its reply.
4. `GET /api/chats/:chatId/files/:fileId` streams the file from R2, gated by
   chat ownership.
5. UI: an inline attachment chip in the transcript when the tool fires,
   linking to the download route.

**Testing**: `worker` — filename sanitization/validation, R2 write +
D1-row-together invariant (a failure partway must not leave an orphaned R2
object or a dangling D1 row — see Failure Modes). `client` — attachment
chip rendering. `integration` — the tool call end to end (fake model
scripted to call the tool) produces a downloadable file only its owner can
fetch; a different user's request for the same file ID is rejected.

**Definition of done**: asking the agent to produce a document reliably
yields a real, downloadable, ownership-protected file.

### Phase 10 — Feature: Tool — Fetch A URL Safely (US-9) (tag: `phase-10-geturl-tool`)

1. Declare a `worker_loaders` binding (`LOADER`) on the main Worker script
   per Spike C's confirmed wiring. Implement `EgressGateway extends
   WorkerEntrypoint<Env>` in `src/worker/egress/gateway.ts`: its `fetch()`
   checks the outbound request's hostname against a committed allow-list
   (`src/worker/egress/allowlist.ts`), forwards the request via an ordinary
   `fetch()` when allowed, and returns a `403` `Response` (not a thrown
   error — the calling Dynamic Worker's own `fetch()` should see a normal,
   inspectable HTTP response for a blocked destination) when not, logging
   both outcomes via `cloudflareLogger()` with the destination host, the
   chat ID (threaded through `ctx.props`), and the allow/block decision —
   never the response body.
2. Implement the sandboxed fetcher as a small, fixed Dynamic Worker module
   (`src/worker/egress/sandboxed-fetch-worker.ts`, bundled as a string/
   template, not a separately deployed script) that only does one thing:
   `fetch(url)` and return bounded, truncated text content. Load it once,
   cached, via `env.LOADER.get("get-url-tool", () => ({ ...,
   globalOutbound: ctx.exports.EgressGateway({ props: { chatId } }) }))` —
   `get()`, not `load()`, since the module's code never changes per call
   (Section 6.7).
3. Implement the `getUrl` tool (Zod-validated URL input, reject non-`http(s)`
   schemes and obviously-internal address literals as a defense-in-depth
   floor even before the gateway's own check) exposed in `ChatAgent`'s
   `streamText()` `tools`, calling the cached Dynamic Worker's entrypoint
   and shaping its result (success text, or a structured "blocked" outcome)
   for the model. A blocked destination must produce a tool result the
   model can explain to the user, not an unhandled error that aborts the
   turn.
4. Seed the demo's allow-list with a small number of real, stable hostnames
   (documented in `DEMO.md` for the presenter to reference).

**Testing**: `worker` — URL validation floor, `EgressGateway`'s allow/block
decision and logging (unit-testable in isolation by injecting a fake
`fetch`, per Spike C's finding — no real network call needed here),
tool-result shaping for both allowed and blocked outcomes. `integration` —
the full path (tool → Dynamic Worker → `EgressGateway` → real `fetch()`) for
an allow-listed destination succeeds (this necessarily touches the real
Internet, documented like Phase 4's dynamic-route test, and requires the
Workers Paid plan Spike C confirmed); a request to a non-allow-listed
destination is blocked before it reaches the network and the turn completes
with an explanatory model response rather than failing.

**Definition of done**: the presenter can ask the agent to fetch an allowed
URL (it works) and a disallowed one (it is visibly, gracefully refused).

### Phase 11 — Feature: Personal And Enterprise Skills (US-10) (tag: `phase-11-skills`)

1. Add the `skills` D1 migration.
2. Per Spike D's decision: either wire the real `@cloudflare/think`
   Agent Skills mechanism into `ChatAgent` (if found composable), or
   implement the hand-rolled `activateSkill` tool + catalog-in-system-prompt
   + fetch-on-demand-from-R2 design the spike prototyped.
3. `POST /api/skills` (personal, `owner_email` = caller) and
   `POST /api/admin/skills` (enterprise, `owner_email = NULL`, admin-only),
   each accepting an upload or a URL source, storing content in R2 and a
   catalog row in D1. `DELETE /api/skills/:id` (owner or admin only).
4. `ChatAgent` builds its per-request skill catalog from the union of
   enterprise skills and the caller's own personal skills — never another
   user's personal skills.
5. UI: a skills management view (personal, for any user; enterprise, admin
   section) and a visible indicator in the transcript when a skill was
   activated for a turn.

**Testing**: `worker` — catalog composition (enterprise ∪ own personal,
never another user's personal), upload/URL ingestion validation.
`client` — skills management CRUD, activation indicator. `integration` — a
turn that should match a seeded skill activates it (verified via the fake
model's tool-call trace) and one user's personal skill is invisible to
another user's chat.

**Definition of done**: adding a skill visibly changes agent behavior only
when relevant, without a redeploy, with correct personal/enterprise
visibility.

### Phase 12 — Feature: Export A Chat Or A File (US-11) (tag: `phase-12-export`)

1. `GET /api/chats/:id/export` — builds a Markdown document (every turn,
   tool calls/results including skill activations, and the chat's
   cost/token summary from `chat_usage`) server-side (unlike demo
   5, where export was a pure client-side operation on data already in the
   browser — here, the transcript and cost ledger are both durable
   server-side state, so building the export server-side avoids trusting
   the client's in-memory view).
2. `GET /api/chats/:chatId/files/:fileId/export` — wraps a single generated
   file's content in a Markdown document carrying the cost/token context of
   the turn that produced it (joining `chat_files` back to its originating
   `chat_usage` row via the chat and an approximate turn correlation —
   document the exact correlation key chosen, since `chat_usage` is
   currently keyed per turn per chat, not per tool call).
3. UI: an "Export" control on the chat header and on each file attachment
   chip, triggering a browser download of the returned Markdown.

**Testing**: `worker` — Markdown builder correctness (pure function,
snapshot- or structure-tested) separately from the HTTP handler.
`integration` — exporting a chat with at least one tool call, one skill
activation, and one completed turn produces a document containing all of
them and the correct cost total; exporting a file produces a document
wrapping that file's content with its cost context; a non-owner cannot
export another user's chat or file.

**Definition of done**: every exportable artifact (chat, file) produces a
complete, correctly attributed Markdown document, ownership-checked.

### Phase 13 — Cleanup And Documentation (tag: `phase-13-cleanup`)

1. Re-run the full verification suite: formatting, linting, type-checking,
   all three Vitest projects with coverage, production build,
   `terraform fmt -check`/`validate`. Close any coverage gaps surfaced by
   the incremental phases above (a common source: error paths added late in
   a phase, like the `getUrl` block-outcome branch).
2. Write `README.md` (operator/developer guide following the exact scope
   AGENTS.md's Documentation section defines: prerequisites — **explicitly
   including the Workers Paid plan requirement for Dynamic Workers**,
   flagged prominently since it is the first plan-tier requirement in this
   curriculum — environment configuration including every permission this
   demo's many Terraform resources need (Workers AI, AI Gateway, D1, R2;
   Dynamic Workers itself needs no Terraform resource, per Section 6.7),
   local dev, testing, exact deployment steps, post-deploy verification, a
   troubleshooting table, exact teardown).
3. Write `DEMO.md` (presenter script covering the full user-story sequence
   in a natural narrative order: sign in → new chat → basic vs. reasoning →
   dictate a prompt → watch cost accumulate → sign in as an admin →
   set a colleague's business/geo and watch their model change → ask for a
   file → ask it to fetch an allowed then a blocked URL → add a skill and
   watch it activate → export a chat).
4. Write `EXPLAIN-DEMO.md` (what this demo teaches — the Agents SDK, dynamic
   routing, governed egress, skills — how it works, the design decisions in
   Section 6/7 of this plan, and Further Reading linking the current docs
   pages this plan's research cited; and a pointer to
   `docs/06-MCP-SUPPORT.md` for the deliberately-deferred MCP integration).
5. Add JSDoc to every authored TypeScript declaration; confirm it describes
   **implemented**, not planned, behavior — several phases above are
   written against spike findings that may have shifted the final shape.
6. Finalize `.env.example` from the baseline, adding every permission this
   demo's Terraform actually needs (Workers AI, AI Gateway, D1, R2) — audit
   against what Terraform's providers actually required during real
   deployment, not only what was anticipated in Section 6.
7. Confirm every spike's `docs/DECISIONS.md` entries and this document's own
   spike-driven corrections are consistent with what was actually built —
   a phase that diverged from its spike's finding during implementation
   must have that divergence reconciled in both places before this phase
   closes.

**Definition of done**: a new operator can deploy and completely tear down
this demo using `README.md` alone; a presenter can run `DEMO.md` alone; a
reader understands what the demo teaches from `EXPLAIN-DEMO.md` alone — the
same three-way separation every other demo in this repository holds itself
to.

## 10. Trade-Offs And Risks

- **Spike-driven phases carry residual risk.** Phases 4, 8, 10, 11, and 12
  are written against spike findings gathered before any feature code
  exists; a spike's report may itself need revisiting once the real feature
  is built at scale (for example, a dynamic-route conditional that behaves
  differently once real per-user metadata volume exists). Treat each
  phase's own "Definition of done" integration tests as the final authority,
  not this plan's prose.
- **This demo's scope is unusually large for one demo.** The user-story
  count and phase count both exceed every prior curriculum demo. This is a
  deliberate, backlog-sanctioned exception (Section 2), not scope creep —
  but it means the total build time is closer to a small capstone than a
  single-lesson demo, and phases should not be compressed to "save time" at
  the cost of the "fully functional and tested at the end of every phase"
  rule.
- **Cost ledger accuracy depends on `onFinish` firing reliably.** Durable
  Object eviction mid-stream, a client disconnect, or a Workers AI failure
  after the first token are all paths where `onFinish` might not fire or
  might fire with partial usage. Phase 6 and Phase 2's integration tests
  must cover this explicitly (see Failure Modes below); an inaccurate cost
  ledger would undermine the entire admin cost/reporting feature built on
  top of it in Phase 7.
- **Dynamic Workers requires a Workers Paid plan, and its finer wiring
  details are genuinely undetermined until Spike C runs.** This is the
  first curriculum demo with a plan-tier prerequisite beyond an ordinary
  Cloudflare account — document it prominently rather than letting an
  operator discover it as a deploy-time failure. If Spike C finds that a
  Durable Object cannot reach a `worker_loaders` binding or the
  `globalOutbound` gateway wiring at all, Phase 10 must be rewritten to the
  Sandbox SDK fallback, which reintroduces the Docker-dependent local-dev
  story this plan otherwise avoids — document that trade-off explicitly in
  `README.md` if it happens.

## 11. Failure Modes And Edge Cases

- **A turn is aborted or errors before `onFinish`.** No `chat_usage` row is
  written (Phase 6); the transcript shows the turn as stopped/failed, not
  silently truncated; retried by the user as an ordinary new prompt.
- **AI Gateway's `getLog()` never returns usable data for a turn** (the
  request predates logging being enabled, the log expired, or the platform
  genuinely has no record). `reconcileUsage()` exhausts its bounded retry
  count and leaves the row `estimated` permanently — this is a legitimate,
  visibly-labeled outcome (Section 6.6), not a defect to paper over with an
  unbounded retry loop.
- **A chat is deleted before its pending reconciliation task runs.**
  `reconcileUsage()` must detect the missing `chat_usage` row/chat and exit
  cleanly rather than throwing, so a stale scheduled task from a deleted
  chat cannot surface an error or resurrect a row for content the user
  already removed.
- **Two `env.AI` calls are in flight in the same `ChatAgent` instance close
  together** (for example the main turn and Phase 3's auto-title
  generation). If Spike F finds `env.AI.aiGatewayLogId` reflects only "the
  most recent call" and can be clobbered by an interleaved one, the demo
  must serialize such calls (capture the log ID synchronously immediately
  after the relevant `run()`/`streamText()` resolves, before starting any
  other AI call in that instance) rather than risk attributing one turn's
  cost to another's log ID.
- **`reconcileUsage()`'s `broadcast()` call runs with no client currently
  connected** to that chat (the user closed the tab, or is viewing a
  different chat). This must be a safe no-op — the reconciliation still
  completes its `setState()`/D1 update regardless of whether anyone is
  listening, and the next client to connect gets the correct, already-
  reconciled number from `state` hydration rather than the transition
  animation it would have played had it been connected at the time.
- **A tool call fails (R2 write error, blocked egress).** The tool returns a
  structured failure result to the model, which must be able to explain it
  in its reply — never let a tool failure throw an unhandled exception that
  aborts the whole streaming response for reasons unrelated to the tool.
- **`writeMarkdown`'s R2 write succeeds but the D1 insert fails, or vice
  versa.** Order operations so a partial failure never leaves a downloadable
  file that the app cannot see (D1 insert only after a confirmed R2 write),
  and if the D1 insert fails after a successful R2 write, either retry the
  insert or delete the now-orphaned object — Phase 9 must pick one and test
  it explicitly.
- **A chat is deleted while a turn is in flight.** The Durable Object
  teardown (mirroring demo 4's `destroy()`) must close any live connection
  with a clear code the client distinguishes from a transient drop, exactly
  as demo 4 already established for channel removal.
- **A user's `business`/`geo` metadata is unset.** Phase 8's conditional
  routing needs an explicit default branch (documented, not left to
  whatever the dynamic route's editor does with an unmatched condition) so
  an unclassified user still gets a sensible model, not a routing error.
- **An admin demotes themselves (`is_admin = 0`) or the `ADMIN_EMAIL`
  bootstrap runs against a database where that email already exists with a
  different `is_admin` value.** The bootstrap in Phase 1/Scaffolding is
  intentionally idempotent and re-asserts `is_admin = 1` for `ADMIN_EMAIL`
  on every relevant request path specifically so this cannot lock every
  admin out permanently.
- **A skill's uploaded content is malicious or oversized.** Cap upload size
  and validate that skill content is plain Markdown/text (no executable
  content is ever run — Spike D's hand-rolled fallback explicitly excludes
  `run_skill_script`-equivalent behavior unless a future revision decides
  otherwise and threat-models it separately).

## 12. Security, Privacy And Compliance

- Every route requires a verified Cloudflare Access identity; no bypass
  policy exists anywhere on this hostname.
- Chat content, generated files, and skills are all scoped to their owner
  at the D1/R2 layer, checked on every read and write, admin routes
  included (an admin reads cost aggregates and writes metadata, never
  another user's chat content).
- `getUrl`'s egress path enforces its allow-list inside the `EgressGateway`
  `WorkerEntrypoint` that intercepts every outbound request the sandboxed
  Dynamic Worker makes — never inside the sandboxed code itself, which
  never sees the allow-list or any credential the gateway might attach.
  Application-level URL validation in the tool handler is a
  defense-in-depth floor, not the primary control (Section 6.7, Phase 10).
- The Dynamic Worker running `getUrl`'s fetch receives **no bindings**
  beyond `globalOutbound` — it cannot reach D1, R2, or any other resource
  this demo's main Worker can, following the "block the Internet, then
  constructively offer specific capabilities" default-deny model Dynamic
  Workers documents as its cleanest configuration.
- No secret (Cloudflare API token, Access JWT, provider credential) is ever
  logged, matching every prior demo's observability rule.
- Skill and generated-file content is treated as untrusted-origin text fed
  back into the model's context; this demo does not execute skill or
  tool-fetched content as code anywhere.

## 13. Observability And Operations

- `cloudflareLogger()` throughout, no custom log-level scheme, per
  AGENTS.md/`docs/DECISIONS.md` #5.
- Informational structured logs per feature, placed after their
  authorization guard: `chat_created`, `chat_deleted`, `turn_completed`
  (model, route, TTFT, token counts — never prompt/response content),
  `usage_reconciled` (chat id, `cost_source` before/after, attempt count —
  emitted whether reconciliation succeeded, is still retrying, or gave up
  permanently, so the estimated-vs-confirmed mix is visible in Workers Logs
  independent of the UI badge), `tool_invoked` (tool name, chat id, outcome
  — never tool input/output content beyond what is safe),
  `admin_metadata_changed`, `skill_activated`, `export_generated`.
- AI Gateway's own dashboard (per-route request volume, cost analytics,
  rate/spend-limit hits) is the operator-facing cross-check for Phase 6/8's
  cost and routing behavior, called out explicitly in `DEMO.md`.
- Workers Logs and automatic tracing enabled with explicit sampling from
  Scaffolding onward, per AGENTS.md.

## 14. Testing Strategy

- The standard three-Vitest-project structure (`worker`, `client`,
  `integration`) applies to every feature phase from Phase 2 onward, exactly
  as AGENTS.md's Testing And Verification section specifies — no phase
  defers its tests to Cleanup.
- Spikes (Phase 0) are explicitly exempt from this structure per Section 8:
  no test is written for a spike unless that test is the mechanism running
  the spike against the real platform.
- Where a feature phase's integration coverage must exercise a real,
  non-locally-simulated Cloudflare surface (AI Gateway dynamic routes in
  Phase 4, egress control in Phase 10), that phase's own section says so
  explicitly and documents the seam in `README.md`'s testing section,
  following demo 5's precedent for Workers AI's own lack of local
  simulation.
- `@vitest/coverage-istanbul` and a `test:coverage` script from Scaffolding
  onward; uncovered authored source is a gap each phase closes before
  moving on, not a backlog item for Phase 13.

## 15. Open Questions

- **Exact dynamic-route conditional-expression syntax and whether it is
  Terraform-manageable** — resolved by Spike B; this plan's Phase 4/8 detail
  must be corrected in place once known, not left as written here if it
  turns out wrong.
- **Whether a Durable Object can use a `worker_loaders` binding and
  `ctx.exports`-based `globalOutbound` gateway the same way a top-level
  Worker `fetch()` handler can** — resolved by Spike C; if it cannot, Phase
  10 needs a rewrite to the Sandbox SDK fallback before that phase starts.
- **Whether the demo's target Cloudflare account is confirmed on a Workers
  Paid plan** — an operator precondition, not a spike question, but
  `README.md` (Phase 13) must state it prominently since it is new to this
  curriculum.
- **Whether Agent Skills (`@cloudflare/think`) is composable with
  `AIChatAgent`, or genuinely `Think`-only** — resolved by Spike D; this is
  the single biggest fork in this plan's shape, since choosing `Think`
  instead of `AIChatAgent` anywhere would ripple back through Phases
  2–12's agent-class assumptions.
- **Whether mid-chat route switching is allowed** — a product decision, not
  a technical unknown; Phase 4 should record whichever choice is made and
  why in `EXPLAIN-DEMO.md`.
- **Whether `env.AI.aiGatewayLogId`/`getLog()` are reachable at all through
  `workers-ai-provider`'s `streamText()` integration, and whether a dynamic
  route name can be passed as the `AI` binding's model argument in the
  first place** — resolved by Spike F; if a dynamic route can only be
  called through the OpenAI-compatible HTTP endpoint rather than the `AI`
  binding, Section 6.6's reconciliation mechanism needs to be rebuilt
  around whatever log-ID mechanism that endpoint exposes instead, before
  Phase 6 starts.
- **The measured lag between a turn completing and `getLog()` returning
  populated data**, which sets Phase 6's `this.schedule()` delay and
  backoff — resolved by Spike F, not guessed at in this document.
- **Exact correlation key between a `chat_files` row and the `chat_usage`
  row(s) that produced it**, needed for Phase 12's per-file cost export —
  Phase 9 should decide this when `chat_files` is designed, not defer it to
  Phase 12.
