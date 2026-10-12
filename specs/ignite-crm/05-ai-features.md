# Ignite CRM — AI features: specification and implementation plan

## 1. Purpose and scope

This document specifies two AI surfaces for Ignite CRM and the plan to build them:

1. **AI Chat** — an in-product assistant opened from a **Chat** icon in the top app bar, shown in a
   side panel on the right. It answers questions about the installation's own CRM data and can make
   changes, within exactly the authority the signed-in user already has.
2. **MCP server** — a remote Model Context Protocol endpoint at `POST /mcp`, so the same workflows
   can be driven from an agentic harness (OpenCode, Claude, ChatGPT) under the same identity and the
   same permissions.

Both are the release that [`00-introduction.md`](./00-introduction.md) §3.6 and
[`01-specification.md`](./01-specification.md) §8.2 deferred. The reserved `/mcp` path, the
`channel` field on `ActorContext`, and the "one grouped RPC contract, many composition surfaces"
boundary were all put in place for this work; this document consumes them rather than redesigning
them.

### 1.1 What is deliberately _not_ in scope

- **No autonomous or scheduled agent actions.** Every turn is initiated by a human in that turn,
  which is the `[W]` boundary in `00-introduction.md` §3.6 and the reason the chat session is
  disposable rather than a standing background worker.
- **No separate OAuth authorization Worker.** `microservice-experiment/01h-oauth-spec.md` is
  superseded: Cloudflare Access now has **Managed OAuth**, so Access itself is the authorization
  server for non-browser clients. See §6.2.
- **No destructive or administrative tools** in either surface: no delete, no invite, no role
  change, no status change on a person. See §4.4.
- **No second datastore.** Chat transcripts live in their own Durable Object and are deleted on
  eviction; nothing about a conversation is written to D1.
- **No new permission vocabulary.** The assistant is not a role. It is a transport.

### 1.2 The one rule both features obey

> An AI surface may never be a privilege-escalation path. Anything the assistant can do, the user
> could have done themselves in the browser; anything the user may not do, the assistant may not do
> for them — and the enforcement happens in the Data Worker, not in the prompt.

Prompting is not a security control. Tool filtering (§3.3) is a usability and blast-radius control;
the authoritative check is the same RBAC check every HTTP route already goes through, because both
surfaces call the same `DataService` RPC methods that the API calls. A model that hallucinates a
tool call it is not entitled to make receives the same `FORBIDDEN` a browser would.

## 2. Architecture

### 2.1 Where the new code lives

Both surfaces are **Application Worker** composition surfaces over the existing grouped
`DATA_SERVICE` RPC binding. Neither gets its own database, and neither calls the HTTP API over the
network.

```text
Browser SPA ─ WebSocket ─┐
                         ├─▶ Application Worker ─┬─ agent tool core ─▶ DATA_SERVICE (RPC) ─▶ D1
Agent harness ─ HTTP ────┘                       └─ Workers AI ▶ AI Gateway (chat only)
```

```text
src/
├── shared/
│   ├── agent/
│   │   ├── catalogue.ts          # tool names, Valibot input/output schemas, descriptions
│   │   └── chat-protocol.ts      # browser↔DO frame types shared by the panel and the agent
│   └── data-service/contract.ts  # unchanged except ActorContext.channel (§2.3)
├── application-worker/
│   ├── agent/
│   │   ├── tools.ts              # one tool registry: schema + required permission + handler
│   │   ├── permissions.ts        # capability → visible tool set
│   │   ├── presenters.ts         # domain result → text summary + structured content
│   │   └── errors.ts             # ServiceError → tool error, non-enumerating
│   ├── chat/
│   │   ├── chat-agent.ts         # CrmChatAgent (Durable Object, AIChatAgent subclass)
│   │   ├── prompt.ts             # system prompt assembly and grounding rules
│   │   └── route.ts              # /api/v1/chat/* including the WebSocket upgrade
│   └── mcp/
│       ├── server.ts             # stateless createMcpHandler factory
│       └── route.ts              # POST /mcp mount
└── client/components/chat/       # the side panel (Vue)
```

`src/application-worker/agent/` is the shared half. `chat/` and `mcp/` own only their transport:
protocol shaping, streaming, errors, and tests. This is the same split
[`01-specification.md`](./01-specification.md) §4 already requires of `api` and `mcp`.

### 2.2 Why the tool core is shared, and what it must not become

A tool is a **narrow verb over an existing use case**. It is not a query language. There is no
`run_sql`, no `query`, no `update_record(table, id, fields)`. Each tool maps onto one `DataService`
method with a documented schema, which is what makes "the assistant can only do what the user can
do" a structural property rather than an assertion.

The registry entry for one tool is:

```ts
interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /**
   * Permissions the caller must hold for this tool to be offered or executed.
   */
  readonly requires: readonly Permission[];
  /**
   * Whether this tool changes state (drives approval, idempotency, and audit).
   */
  readonly mutates: boolean;
  readonly input: v.GenericSchema<TInput>;
  readonly output: v.GenericSchema<TOutput>;
  execute(context: AgentToolContext, input: TInput): Promise<TOutput>;
  /**
   * Short human sentence for the transcript and for an approval prompt.
   */
  summarise(output: TOutput): string;
}
```

**Valibot, not Zod.** The repository bans Zod ([`02-implementation.md`](./02-implementation.md) §1.1
rule 8) and Valibot implements Standard Schema, which both MCP SDK v2 tool registration and the AI
SDK's `tool({ inputSchema })` accept. The same schema object therefore serves the MCP catalogue, the
chat tool definition, and the response validation, with no second schema library and no hand-written
JSON Schema.

### 2.3 Channel plumbing

`ActorContext.channel` widens from `'api'` to `'api' | 'chat' | 'mcp'`. Every tool call resolves an
actor exactly as a route does — from the verified Access identity, never from tool arguments — and
stamps the channel it arrived on.

Audit rows gain the channel, so an owner reviewing the audit trail can tell a browser click from an
assistant action from an agent harness:

- migration `0008_agent_channel.sql` adds
  `channel TEXT NOT NULL DEFAULT 'api' CHECK (channel IN ('api','chat','mcp'))` to `audit_events`;
- the default is what makes the migration safe for existing rows, which were all browser actions;
- the audit list API and the Audit view gain a channel column and filter.

This is the only schema change either feature needs.

## 3. Feature one: AI Chat

### 3.1 User experience

- A **Chat** icon (`mdiChatProcessingOutline`) sits in the top app bar, next to the account menu. It
  is a toggle with `aria-expanded` and `aria-controls` pointing at the panel.
- Activating it opens a **right-hand side panel** (Vuetify `v-navigation-drawer location="right"`,
  `temporary` below the `md` breakpoint so it overlays on a phone, `permanent` above it so the
  record under discussion stays visible). Width is 420 px, resizable is out of scope.
- The panel contains: a header with the title, a **Clear chat** action and a close button; the
  transcript; and a composer with a multi-line input and Send.
- The transcript shows user messages, assistant Markdown (through the existing `MarkdownView`
  pipeline, so sanitisation is already solved), tool activity as a compact "Looked up Northwind
  Traders" line, and an approval card for a pending write (§3.5).
- Every record the assistant names is a link into the SPA, because the useful next action after
  "three deals are stalling" is opening one.
- `Esc` closes the panel and returns focus to the Chat button. The panel is a focus trap only while
  `temporary`, matching Vuetify's own drawer behaviour.
- The conversation survives a page reload within its lifetime (§3.6), because the transcript lives
  server-side in the Durable Object, not in the tab.

### 3.2 Durable Object per chat session

One `CrmChatAgent` Durable Object instance per chat session, extending `AIChatAgent` from
`@cloudflare/ai-chat`:

```ts
export class CrmChatAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    /* streamText with the permitted tools */
  }
}
```

**Instance naming is a security decision.** The instance name is `${userId}:${sessionId}` where
`sessionId` is a server-generated UUID. The browser never chooses the full name on its own, and the
agent re-checks on every connection that the verified Access identity owns the prefix. Otherwise a
user could connect to another user's session by guessing its name and read a transcript containing
data they may not see.

**Why a Durable Object at all.** A chat turn is a multi-second, multi-round, stateful conversation
with tool calls in the middle of it. A plain Worker cannot hold the WebSocket (the repository rule
in the root [`AGENTS.md`](../../AGENTS.md#websockets-and-durable-objects) says exactly this), and a
stateless design would have to replay the whole transcript from a datastore on every message.
`AIChatAgent` additionally gives message persistence in the object's own SQLite, resumable streaming
when a browser reconnects mid-answer, and durable recovery if the object is evicted while the model
is streaming.

The transcript is **not** business data. It never enters D1, and nothing about a conversation
survives its session: when the session is evicted (§3.6) the transcript is genuinely gone, not
archived. That is the designed privacy posture rather than an omission — the authoritative record of
what changed is the audit trail, which names the actor, the change, and the channel, and which
outlives the conversation that produced it.

A retention story (transcripts in D1 behind a policy, searchable, exportable) was considered and
rejected for this release. It is a larger change than it looks: transcripts would become customer
data with their own RBAC, their own retention rules, and their own deletion obligations, which is a
second product rather than a feature of this one.

**Session scope.** A session belongs to one user. Opening the panel joins the live session if the
user has one and otherwise starts a fresh one, so a reload rejoins the conversation and a second tab
sees the same live transcript through the same object. Nothing is carried across an expiry, and
there is no long-lived per-user session that accumulates history indefinitely.

### 3.3 Grounding: how the assistant knows about the CRM

Grounding is by **tools over the live RPC contract**, not by a vector index.

This is a deliberate choice and worth stating plainly, because "ground the AI in your data" usually
means embeddings. A CRM is the wrong shape for that as a primary mechanism:

- the data changes constantly, so an index is stale the moment a deal moves, while a tool call reads
  the committed row;
- the answers users want are aggregates and filters ("which deals close this quarter", "what is
  stalling"), which are precisely what the existing reports already compute correctly;
- an embedding index is a **second copy of the data with no permission model**, so it would either
  leak across users or need its own parallel RBAC — the exact escalation path §1.2 forbids.

So the system prompt carries no customer data. Each turn is assembled as:

1. **Identity and capability header** — the user's display name, roles, and the permissions they
   hold, so the model does not offer to do something it will then be refused.
2. **Installation context** — today's date in the installation time zone, the currency, the date
   format, and the fixed pipeline stage names. Small, non-sensitive, and it stops the model
   inventing a stage called "Negotiation".
3. **Behavioural rules** — answer only from tool results; never guess an identifier; say when a tool
   returned nothing; use the user's local formats; never state a total you did not read from a
   report tool.
4. **The permitted tool catalogue** (§4), filtered to the caller's capabilities.
5. **Optional page context** — the record the user is currently looking at, sent by the panel as
   `{ route: 'contact', id }`, so "summarise this customer" works without the user pasting an id. It
   is a _hint_: the tool call it leads to is still authorised normally.

Full-text note search is already in the Data Worker (`searchNotes`), so "what did we say about
renewal pricing" is a tool call, not a retrieval index.

### 3.4 Permission-scoped tools

Before the model is called, the agent resolves the caller's permissions once per turn through
`DATA_SERVICE.getSession()` and filters the catalogue:

```ts
const permitted = CATALOGUE.filter((tool) =>
  tool.requires.every((permission) => capabilities.includes(permission))
);
```

A read-only user is therefore never _offered_ `create_note`, which is the difference between an
assistant that says "I can't do that for you — you have read-only access" and one that tries, fails,
and apologises. Filtering is for usability; the Data Worker's own check is for security, and there
is a test that calls a tool a user lacks the permission for and asserts the `FORBIDDEN` outcome
rather than a success.

Capabilities are read per turn rather than cached on the object, so an owner removing a role takes
effect on the user's next message rather than when their chat session expires.

### 3.5 Writes require explicit approval

**Every** mutating tool is declared `needsApproval` (the AI SDK's human-in-the-loop hook, persisted
by `@cloudflare/ai-chat`) — without exception, rather than only the high-impact ones. The stream
pauses, the panel renders an approval card stating exactly what will happen — "Create a note on
Northwind Traders", with the content shown — and nothing is sent to the Data Worker until the user
presses **Approve**.

Applying it uniformly is what makes the rule explainable in one sentence: _the assistant never
changes anything you have not seen and agreed to._ Approving only high-impact tools would be
smoother to use, but it makes the safety story conditional on a judgement about which writes matter,
and a reader copying this demo would have to re-make that judgement for their own domain.

This is not ceremony. A model misreading "note that Acme are unhappy" as an instruction to create a
deal is an ordinary failure mode, and an approval step converts a wrong write into a declined
suggestion. It also gives the demo an honest answer to "would you let an LLM write to your CRM?":
yes, with a confirmation, an audit row, and an idempotency key.

Mechanics:

- The idempotency key is derived once per approved tool call from the chat request id and the tool
  call id, so an approval replayed after a reconnect does not create two records.
- `If-Match` style version checking is preserved: an update tool takes the `version` it read, and a
  concurrent change produces a conflict the assistant reports as "somebody changed this while we
  were talking — shall I re-read it?".
- Rejection calls `addToolOutput(..., 'output-error', 'The user declined this action.')`, so the
  model learns it was declined rather than that it failed.

### 3.6 Eviction after three hours of silence

```ts
/**
 * How long a chat session survives after its last message before it is deleted. Three hours covers
 * a working session with interruptions while keeping transcripts short-lived.
 */
export const CHAT_SESSION_TTL_SECONDS = 3 * 60 * 60;
```

One exported constant in `src/configuration.ts`, so changing the policy is a one-line edit, which is
what "easily configurable in code" asks for.

Implementation: after every persisted message the agent cancels its pending expiry schedule and
calls `this.schedule(CHAT_SESSION_TTL_SECONDS, 'expireSession')`. The callback calls
`this.destroy()`, which drops the object's tables, clears its alarms, and lets the Durable Object be
evicted. A reconnect to an expired session gets an empty transcript and a fresh session id.

Why a rolling schedule rather than a cron sweep: there is no central registry of live sessions to
sweep, and an object that knows its own last-message time can expire itself exactly. The schedule
survives hibernation because it is stored in the object, not in an isolate.

The panel shows nothing about this, with one exception: reconnecting to an expired session shows a
single line, "This conversation expired after 3 hours of inactivity", so a returning user is not
left wondering where their history went.

### 3.7 Model and cost control

- Workers AI through the account-authenticated `AI` binding, routed through a Terraform-owned **AI
  Gateway** (`ai-gateway.tf`) exactly as the `architect` demo does. The gateway gives logs, token
  counts, a rate limit, and a daily spend cap, and it is the reason the demo can be left running.
- The model is **`@cf/zai-org/glm-4.7-flash`**, bound as `AI_CHAT_MODEL` rather than written as a
  literal, so changing it is a configuration edit. It supports function calling and reasoning, which
  are hard requirements here: a model without tool calling cannot serve this feature at all. It is
  available within Workers AI's normal free allowance and is optimised for dialogue, instruction
  following, and multi-turn tool use.
- The free allowance is finite, so the gateway's rate limit and daily spend cap remain part of the
  design. They keep an unattended tab from exhausting the daily budget and make any later move to
  paid Workers AI deliberate.
- Caching is off at the gateway: a tool-calling turn is stateful and replaying a cached round would
  repeat stale prose or skip a write.
- `stopWhen: stepCountIs(8)` bounds a turn's tool rounds. `maxPersistedMessages` bounds transcript
  growth, and `pruneMessages` bounds what is actually sent to the model.
- No prompt or response content is written to the Worker's structured logs. The gateway holds the
  content; Workers Logs holds the metadata.

## 4. The shared tool catalogue

One catalogue serves both surfaces. The chat agent filters it by capability and wraps mutations in
approval; MCP exposes it as protocol tools. A tool added once appears in both, and a parity test
asserts the two catalogues are the same set.

### 4.1 Read tools

| Tool                 | Requires       | Behaviour                                                      |
| -------------------- | -------------- | -------------------------------------------------------------- |
| `whoami`             | —              | Display name, roles, capabilities. Never a token.              |
| `search_customers`   | `crm.read`     | Bounded contact/company search by name, e-mail, or company.    |
| `get_contact`        | `crm.read`     | Contact detail with company, next action, and recent activity. |
| `get_company`        | `crm.read`     | Company detail with its contacts and open deals.               |
| `list_deals`         | `crm.read`     | Filter by stage, status, owner, expected close window.         |
| `get_deal`           | `crm.read`     | Deal detail including stage history and activity.              |
| `action_stream`      | `crm.read`     | The caller's own follow-up queue.                              |
| `pipeline_summary`   | `report.read`  | Counts and value by stage, plus the quarter total.             |
| `quarterly_pipeline` | `report.read`  | One calendar quarter's open deals by stage.                    |
| `list_projects`      | `project.read` | Filter by status and owner.                                    |
| `get_project`        | `project.read` | Project detail with bounded task list.                         |
| `my_work`            | `project.read` | The caller's assigned tasks.                                   |
| `search_notes`       | `note.read`    | Full-text search over notes the caller may read.               |
| `get_note`           | `note.read`    | One note's Markdown and its links.                             |
| `delivery_report`    | `report.read`  | Task counts by status across active projects.                  |

### 4.2 Write tools

Every one of these is `mutates: true`: approval in chat, idempotency key and audit row on both
surfaces.

| Tool                   | Requires        | Behaviour                                      |
| ---------------------- | --------------- | ---------------------------------------------- |
| `create_contact`       | `crm.write`     | Including the reuse-or-create company rule.    |
| `update_contact`       | `crm.write`     | Version-checked partial update.                |
| `update_company`       | `crm.write`     | Version-checked partial update.                |
| `create_deal`          | `crm.write`     | On an existing company or contact.             |
| `update_deal`          | `crm.write`     | Stage, value, expected close, status line.     |
| `set_deal_outcome`     | `crm.write`     | Won/lost, version-checked.                     |
| `log_activity`         | `crm.write`     | A call or meeting against contacts and a deal. |
| `set_next_action`      | `crm.write`     | The follow-up a contact is waiting on.         |
| `complete_next_action` | `crm.write`     | Closes the current follow-up.                  |
| `convert_deal`         | `deal.convert`  | The same idempotent saga the API runs.         |
| `create_task`          | `project.write` | On an active project.                          |
| `update_task`          | `project.write` | Status, assignee, due date.                    |
| `create_note`          | `note.write`    | Markdown with validated record links.          |
| `update_note`          | `note.write`    | Version-checked.                               |

### 4.3 Schema and result conventions

- **No actor fields.** No tool accepts `email`, `userId`, `actorId`, or `role`. A schema is
  `strictObject`, so a model that invents one gets a validation error rather than silent acceptance.
  There is an explicit test per surface for a smuggled actor field.
- **Bounded output.** List and search tools default to 20 results and cap at 50, with a cursor. No
  tool returns an unbounded graph.
- **Identifiers and versions are always returned**, so a following tool call can mutate safely.
- **Each success returns both** a one-sentence human summary and structured content matching the
  output schema. The summary is what a model quotes; the structured content is what a harness
  parses.
- **Errors are non-enumerating.** A record the caller may not see produces the same "not found" as
  one that does not exist, matching the HTTP surface. Validation failures name the field. Every
  error carries the request id and whether a retry is sensible.
- **Descriptions carry the domain's traps**, because a model only ever sees the catalogue: that the
  free-text status line is not the won/lost outcome; that notes are separate multi-linked documents,
  not a field on a contact; that stages are fixed.

The three `report.read` tools are available to **every** role, including read-only, because the
seeded matrix grants that permission to every role and the browser already shows those same
aggregates to everyone. The assistant deliberately does not hold a stricter line than the UI: a
surface that refuses to total what the dashboard is already displaying would be confusing rather
than safer.

### 4.4 What is deliberately absent

No delete of any kind, no `invite_user`, no `set_user_roles`, no `set_user_status`, no configuration
change. An owner retains those powers in the browser, where the confirmation and the context are
richer. The blast radius of a confused agent should not include the team's membership, and a demo
that teaches otherwise is teaching the wrong thing. `users.read` is not exposed either: `whoami`
answers "who am I", and the team directory is not the assistant's business.

## 5. Feature two: the MCP server

### 5.1 Shape

`POST /mcp`, Streamable HTTP, **stateless**: `createMcpHandler` from `agents/mcp/server` with a
per-request factory returning an `McpServer` from `@modelcontextprotocol/server` v2. No `McpAgent`,
no Durable Object, no session state — the tools are request/response calls over RPC, so there is
nothing to keep between them.

This differs from the chat feature on purpose, and the contrast is part of the lesson: chat is a
stateful conversation and therefore a Durable Object; MCP is a stateless tool surface and therefore
a plain handler. Using a Durable Object for MCP would add eviction, naming, and hibernation concerns
to solve a problem that does not exist.

The handler is built once at module scope. The caller's identity reaches a tool through the
per-request server factory, so a tool closure belongs to exactly one caller and nothing
identity-shaped is ever stored on the handler.

### 5.2 Authentication: Cloudflare Access Managed OAuth

**The Worker implements no OAuth.** `oauth_configuration` is added to the existing Terraform-owned
Access application, which turns Access itself into the OAuth 2.1 authorization server:

```hcl
oauth_configuration = {
  enabled = true
  dynamic_client_registration = {
    enabled                = true
    allow_any_on_loopback  = true
    allow_any_on_localhost = true
  }
  grant = {
    access_token_lifetime = "15m"
    session_duration      = "336h"
  }
}
```

- The client receives a `401` with a `WWW-Authenticate` header pointing at Access's discovery
  metadata, opens a browser, the user signs in, and the client gets an **opaque** token.
- Access resolves that token at its edge and forwards a signed `Cf-Access-Jwt-Assertion` header, so
  from the Worker's side an agent's request is indistinguishable from a browser's. The existing
  Access middleware and its audience check work unchanged.
- The loopback and localhost allowances are not laxity: `allowed_uris` requires `https`, while OAuth
  2.1's native-app exception means a harness redirects to `http://127.0.0.1:…`, so these flags are
  the only mechanism that admits such a client.
- The short access token against a long grant session is load-bearing: Access re-evaluates policy on
  every silent refresh, so a suspended identity loses access within one token lifetime.

It goes on the **existing** application rather than a second one. Access resolves the most specific
application for a request, so a second application covering `/mcp*` would shadow the first and the
two policy lists would then have to be kept in step by review.

This supersedes `microservice-experiment/01h-oauth-spec.md` in full: no OAuth Worker, no `OAUTH_KV`,
no consent UI, no token storage, and none of that specification's nine open questions. A whole
Worker and its security-critical state disappear into a platform feature, which is itself the lesson
worth demonstrating.

### 5.3 Routing and middleware

- `cloudflare.config.ts` adds `/mcp*` to `runWorkerFirst`. Without it the request falls through to
  the single-page-application asset fallback and the client receives the SPA's HTML, which it
  reports as a protocol error rather than as a routing mistake.
- `buildAccessPolicies` gains `{ pattern: /^\/mcp(?:\/|$)/u, authenticate: true, redirect: false }`
  ahead of the catch-all. `redirect: false` matters for the same reason it does for `/api`: a
  non-browser client cannot follow a login redirect.
- `/mcp` is exempt from the same-origin middleware, by exact pathname match. That middleware rejects
  a state-changing request carrying neither `Origin` nor `Sec-Fetch-Site`, which is every
  non-browser client. CSRF rides an _ambient_ credential a browser attaches automatically, and no
  browser attaches an Access OAuth token, so the exemption costs nothing. A test asserts the
  exemption is an exact match, so a route added later under the same prefix does not inherit it.
- A `GET` to `/mcp` answers `405` with `Allow: POST`.

### 5.4 Identity

The identity comes from the Access JWT, never from the protocol. The SDK's `authInfo` is
deliberately unused: it carries OAuth client metadata, not a user. The verified e-mail goes through
the same `resolveActor` the API uses, with `channel: 'mcp'`.

An idempotency key for a write is taken from the tool arguments when the client supplies one, and
otherwise derived deterministically from the MCP request id and tool name, so a harness that retries
a timed-out call does not duplicate a record.

## 6. Infrastructure and configuration

### 6.1 Ownership

| Resource                                  | Owner      | Note                                                          |
| ----------------------------------------- | ---------- | ------------------------------------------------------------- |
| AI Gateway                                | Terraform  | New `infra/ai-gateway.tf`; logs, limits, cap                  |
| `oauth_configuration` on the Access app   | Terraform  | Attribute on the existing application                         |
| `AI` binding                              | `cf`       | Account-authenticated Workers AI                              |
| `CHAT_AGENT` Durable Object namespace     | `cf`       | Defined by the class the Worker exports                       |
| `AI_CHAT_MODEL`, `AI_GATEWAY_ID` bindings | `cf`       | Model id is a static choice; gateway id is a Terraform output |
| D1 migration `0008_agent_channel.sql`     | migrations | Audit channel column                                          |

The Durable Object namespace stays with `cf` rather than Terraform because a namespace is defined by
the class its Worker exports: it is created by the deploy that uploads that class and retired when
the code stops exporting it. Splitting it would give one resource two owners. `cf` models this as a
`state` field on the export rather than Wrangler's append-only migration tags:

```ts
exports: {
  CrmChatAgent: exports.durableObject({ storage: 'sqlite' });
}
```

SQLite storage is required — `AIChatAgent` persists messages and buffers stream chunks there.

`teardown` is unchanged in shape: deleting the Worker removes the namespace and its sessions, and
Terraform then destroys the gateway. The existing `depends_on` discipline adds the gateway to the
Worker's dependency list so destruction stays correctly ordered.

### 6.2 New dependencies

| Package                        | Why                                           |
| ------------------------------ | --------------------------------------------- |
| `agents`                       | Durable Object agent runtime, MCP handler     |
| `@cloudflare/ai-chat`          | `AIChatAgent`, persistence, resumable streams |
| `ai`                           | `streamText`, `tool`, approval plumbing       |
| `@ai-sdk/vue`                  | `useChat` for the Vue panel                   |
| `workers-ai-provider`          | Workers AI as an AI SDK provider              |
| `@modelcontextprotocol/server` | MCP SDK v2 server                             |
| `@modelcontextprotocol/client` | Protocol tests only (dev dependency)          |

Pinned exactly, since several are pre-1.0. **No Zod**: Valibot's Standard Schema support covers both
tool surfaces (§2.2). The Vue client uses `WebSocketChatTransport` from `agents/chat/transport` with
`@ai-sdk/vue`'s `useChat`; `useAgentChat` is React-only, so history loading, reconnect resume, and
tool continuation are the panel's own responsibility and are tested as such.

### 6.3 Bundle impact

The chat panel is lazily loaded: the agent client, the AI SDK's UI pieces, and the Markdown renderer
stay in dynamic chunks requested only when somebody opens the panel. A user who never opens chat
downloads none of it. `check:bundles` gains a budget for the chat chunk.

## 7. Testing

The repository's standards apply unchanged: test-first for every main interface, happy _and_ error
paths before implementation, ≥80% per-file coverage, a finite integration timeout, and no test that
depends on live infrastructure.

### 7.1 Unit

- Tool schemas: acceptance, rejection of unknown fields, rejection of a smuggled actor field
  (including a differently-cased spelling), bound enforcement on list sizes.
- Capability filtering: each role sees exactly the expected tool set, asserted against
  `SEED_ROLE_PERMISSIONS` so the table and the catalogue cannot drift.
- Presenters and error mapping: `FORBIDDEN` is non-enumerating; a conflict is reported as a
  conflict; no error message echoes stored content.
- Prompt assembly: the system prompt contains the capability header and _no_ customer data; a
  snapshot test guards that second claim.
- Idempotency key derivation is deterministic for a given request and tool call.
- Eviction: the schedule is set on each message, replaced rather than duplicated, and the callback
  destroys the session. Time is injected, not slept.

### 7.2 Workers-runtime integration

Against the real runtime, real D1, and real Durable Objects, with a fake model:

- A chat turn that calls a read tool and streams an answer.
- A write tool that stays unexecuted until approved, executes once on approval, and is not executed
  twice when the approval is replayed.
- A read-only user's turn: the tool is not offered, and calling it directly is refused.
- Session isolation: connecting with a session name belonging to another user is rejected.
- Reconnection mid-stream resumes rather than restarting.
- MCP: initialize, list tools, call one read and one write tool, wrong/absent identity, unknown
  tool, malformed arguments — through an in-memory SDK v2 client.
- The same operation over API, chat, and MCP produces the same authorization outcome and the same
  audit row except for `channel`. This parity test is the one that proves §1.2.

The model is a deterministic fake implementing the provider interface: tests assert the loop, the
tools, and the permissions, never the prose. No test calls Workers AI.

### 7.3 DOM

Panel open/close and focus return, `aria-expanded`/`aria-controls`, keyboard operation of the
composer and the approval card, streaming render, the expired-session notice, and that the panel is
not in the initial bundle.

### 7.4 End-to-end

Playwright, with the model faked at the Worker boundary: open the panel from the app bar, ask a
question, see a grounded answer, approve a write, and see the record change in the UI behind the
panel. Plus an axe pass on the open panel, matching the existing accessibility suite.

### 7.5 What cannot be tested offline

Managed OAuth is an Access-edge feature with no local emulation. Local development exercises `/mcp`
with a development JWT through the identical policy list, which proves the Worker's half and nothing
about Access's. A short `MCP-VALIDATION.md` runbook covers the gap: connect a real client, complete
the browser sign-in, call one read and one write tool, confirm a silent refresh, and confirm a
suspended user is refused. Writing the runbook is not running it; it becomes evidence only once
somebody records a result against a live deployment.

## 8. Implementation plan

Each phase is a reviewable increment that runs locally and deploys. Per the repository rules, every
phase ends with `pnpm check`, `pnpm test` at ≥80% per-file coverage, updated JSDoc and README, and
one conventional commit.

### Phase 1 — Shared tool core

Channel widening (`'api' | 'chat' | 'mcp'`), migration `0008_agent_channel.sql`, the audit channel
column through the Data Worker and the Audit view, and `src/shared/agent/catalogue.ts` with the read
tools and their schemas. `src/application-worker/agent/` gains the registry, the capability filter,
the presenters, and the error mapping — all tested directly, with no transport yet.

_Reviewable:_ the Audit view shows a channel column; the catalogue is exercised by tests.

### Phase 2 — MCP read surface

`createMcpHandler`, the `/mcp` route, the Access policy entry, `runWorkerFirst`, the same-origin
exemption, and the read tools. Terraform adds `oauth_configuration`. Protocol integration tests with
an in-memory client.

_Reviewable:_ an agent harness connects locally with a development JWT and answers questions about
the CRM.

### Phase 3 — Write tools, both surfaces

The mutating tools in the shared catalogue with idempotency, version checking, and audit. Exposed
over MCP now; the chat half arrives with the panel. The API/chat/MCP parity test lands here.

_Reviewable:_ an agent harness creates a note and moves a deal, and the audit trail shows `mcp`.

### Phase 4 — Chat agent

`CrmChatAgent`, the Durable Object export, the AI Gateway in Terraform, the `AI` binding, the prompt
assembly, the capability-filtered tool set, approval for writes, and the three-hour eviction.
Workers-runtime integration tests with a fake model.

_Reviewable:_ a WebSocket client drives a full conversation including an approved write.

### Phase 5 — Chat panel

The app-bar Chat button, the right-hand drawer, the transcript, the composer, the approval card,
record links, page context, the expired-session notice, lazy loading, and the accessibility work.
DOM and Playwright coverage.

_Reviewable:_ the feature as a user meets it.

### Phase 6 — Hardening and documentation

Corner cases, rate-limit behaviour, the bundle budget, `MCP-VALIDATION.md`, README sections for both
features, the `DEMO.md` walkthrough steps, and a deploy/teardown checkpoint on the live hostname.

## 9. Decisions (confirmed)

All five questions raised when this plan was drafted have been answered by the product owner. They
are recorded here, with their reasoning, and each is now reflected in the body of the document
rather than left as an open choice. There are no outstanding questions; Phase 1 can begin.

1. **Model — Workers AI, `@cf/zai-org/glm-4.7-flash`.** Keeps the demo free of third-party API keys
   and inside Workers AI's normal free allowance, while providing the function calling, reasoning,
   dialogue, and multi-turn tool-use behaviour the feature requires. The allowance is finite, so the
   AI Gateway's rate limit and daily cap remain load-bearing. See §3.7.
2. **Approval on every write, without exception.** The uniform rule is explainable in one sentence
   and does not ask a reader to re-make a per-tool judgement for their own domain. See §3.5.
3. **No transcript retention.** Conversations never reach D1 and do not survive their session. The
   audit trail, not the chat log, is the authoritative record of what changed. See §3.2.
4. **Session scope — one live session per user.** Reopening the panel or a second tab rejoins the
   live session; nothing survives an expiry. See §3.2.
5. **`report.read` aggregates available to every role.** The seeded matrix already grants it to
   everyone and the dashboard already displays those totals, so the assistant holds the same line as
   the UI rather than a stricter one. See §4.3.

Two things remain _unknowable_ until the feature meets a real deployment, and neither is a decision
to make now:

- **Managed OAuth** cannot be exercised offline (§7.5). `MCP-VALIDATION.md` is the runbook, and it
  becomes evidence only once somebody records a result against the live hostname.
- **Prompt quality** — how well the chosen model plans multi-step tool use over this catalogue — is
  an empirical result of Phase 4, not a design choice. The tests pin the loop, the permissions and
  the wiring, never the prose, so a later model change is a binding edit rather than a rewrite.
