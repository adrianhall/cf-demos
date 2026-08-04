# Agentic Chat — What This Demo Teaches

This demo is the curriculum's introduction to the Agents SDK: a scaled-down
enterprise AI chat where a signed-in user holds a persistent, multi-turn
conversation with a Durable Object-backed agent, selects between governed AI
Gateway routes, calls tools, and extends the agent's behavior with skills —
all with per-user cost attribution and an admin console. The full design
rationale, requirements, and data flow live in
[`docs/06-AGENTIC-CHAT.md`](../../docs/06-AGENTIC-CHAT.md); this file covers
what the checkout in this directory actually implements.

## What This Demonstrates

- **The Agents SDK's `AIChatAgent` as the mechanism for a persistent,
  resumable, per-entity AI conversation.** One Durable Object per chat gets
  message persistence, resumable streaming, and WebSocket sync for free — the
  application code only implements `onStart()` and `onChatMessage()`. This is
  deliberately not a hand-rolled Durable Object the way `demos/chat`'s
  `ChatRoom` is: that demo's lesson is Durable Object fundamentals; this one's
  is the SDK built on top of them.
- **A Vue client speaking the Agent WebSocket protocol directly**, through
  `agents/client`'s framework-agnostic `AgentClient`, rather than the
  React-only `agents/react` hooks the SDK documents. One composable is the
  single seam between the wire protocol and the rest of the client.
- **AI Gateway dynamic routing as a way to move model selection out of
  application code.** The browser only ever sends a "Basic"/"Reasoning" mode,
  never a model ID; the platform-side route configuration — editable without
  a redeploy — decides the real model, including per-segment conditionals,
  rate limits, and spend limits.
- **Metadata-driven governance with zero client-side branching.** The same
  two-option mode selection resolves to different underlying models depending
  on the caller's business segment, entirely through AI Gateway's own
  conditional and rate-limit route elements and a metadata-partitioned spend
  limit — the browser's request never changes.
- **Tool calling with two qualitatively different security postures.** A
  `writeMarkdown` tool writes to a binding this Worker already trusts; a
  `getUrl` tool runs inside a sandboxed Dynamic Worker whose outbound network
  access is intercepted and allow-listed by an `EgressGateway`
  `WorkerEntrypoint` — "deny by default, permit deliberately" enforced at the
  platform layer, not only in application code.
- **Skills that extend agent behavior without redeploying the Worker.** A
  personal or enterprise Markdown instruction bundle changes what the agent
  does only when a task matches it, at zero cost to every other prompt.
- **A cost ledger that prefers the platform's own authoritative figure over a
  local estimate**, upgraded in place once AI Gateway's own logged cost for a
  turn is found, and pushed to connected clients via the agent's own `state`
  and `broadcast()` rather than a poll.
- **Role-based authorization as an application concern, not an Access
  concept.** "Administrator" is a D1 flag checked by Hono middleware; Access
  gates the whole hostname on identity alone.
- **Exporting durable, server-side state as a portable document.** A chat's
  transcript and cost ledger both live server-side (Durable Object storage
  and D1), so the Markdown export is built server-side too, not from
  whatever the browser currently has in memory.

## How It Works

### Data model

Five migrations build up the schema:

```sql
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  business TEXT,   -- added by migration 0003; validated in application code
  geo TEXT,        -- added by migration 0003; validated in application code
  created_at TEXT NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT,
  route TEXT,       -- "basic" | "reasoning", validated in application code
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_usage (   -- migration 0002
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL,
  cost_source TEXT NOT NULL,  -- "estimated" | "gateway"
  gateway_log_id TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE chat_files (    -- migration 0004
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, r2_key TEXT NOT NULL,
  filename TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  correlation_id TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE skills (        -- migration 0005
  id TEXT PRIMARY KEY, owner_email TEXT,  -- NULL = enterprise
  name TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT,
  r2_key TEXT NOT NULL, created_at TEXT NOT NULL
);
```

`business`/`geo` and `route` are plain, unconstrained `TEXT` columns:
validity is enforced entirely in application code (`isBusiness()`/`isGeo()`
in `src/worker/users/business.ts`, `isChatRoute()` in
`src/worker/chats/route.ts`), and each repository's own row-mapping function
defensively coerces an unrecognized stored value back to a safe default
rather than ever surfacing it to a caller. `chat_files.correlation_id` and
`chat_usage.correlation_id` share the same per-turn UUID, giving an exact
join key between a generated file and the turn that produced it — used
directly by the per-file export route.

### Routing and the Access model

Every path on this hostname requires authentication (`src/access-policies.ts`)
— there is no public route. `src/worker/index.ts` applies `accessMiddleware`
(`src/worker/middleware/access.ts`) to every `/api/*` route; page routes are
served directly by the `ASSETS` binding's single-page-application fallback,
with Access enforcing authentication at the edge before the request reaches
the Worker or that fallback. Because every chat this demo holds is sensitive,
billable conversation history, the Access application pins its `audience`
claim rather than accepting any valid token from the same Zero Trust team.
That claim is threaded in as a Vite build-time define (`VITE_ACCESS_AUDIENCE`,
read from the `access_audience` Terraform output at deploy time), since
`cloudflareAccess()` reads it once at Worker module-load time, before any
request-scoped `env` binding exists.

"Administrator" is a `users.is_admin` column, never a second Access
application — Access has no concept of this demo's business role.
`GET /api/me` (`src/worker/routes/me.ts`) is the only place
`UserRepository.ensureUser()` runs: every sign-in idempotently upserts the
identity's D1 row and re-forces `is_admin = 1` for the identity matching the
Worker's `ADMIN_EMAIL` variable, regardless of prior D1 state, so the role
survives a redeploy or a partial teardown. `requireAdmin()`
(`src/worker/middleware/require-admin.ts`) reads the same column in front of
every `/api/admin/*` route, returning `403` for a non-administrator. The
client's "Admin console" nav link is gated on the same flag purely as a UX
convenience — `AdminView.vue` has no client-side route guard, so a
non-administrator who navigates to `/admin` directly still loads the page
(there is only one Access application on this hostname), but every
underlying admin fetch comes back `403` and renders as an error instead of a
table.

### The `ChatAgent` Durable Object and its Worker-side routing

`src/worker/routes/chats.ts` mounts six routes under `/api/chats`:

- `POST /` creates a chat: a generated ID and a D1 directory row defaulted to
  the `"basic"` route. The `ChatAgent` Durable Object for that ID does not
  need to exist yet — it is created lazily by `getAgentByName()` the first
  time anything addresses it.
- `GET /` lists the signed-in identity's own chats, most recently updated
  first, each entry carrying its own cost/token summary (see the cost ledger,
  below).
- `PATCH /:id` changes a chat's route: validated by exact match
  (`isChatRoute()`), rejected `422` once the chat's first turn has already
  completed (`ChatRepository.setRouteIfUnstarted()` reuses the same
  "`title IS NULL`" signal auto-titling already tracks as "has this chat
  started"). The client disables the mode dropdown the instant a
  turn is submitted as defense in depth, but the server-side guard is what
  actually enforces the rule.
- `DELETE /:id` calls the Durable Object's own `destroy()` — wrapped in its
  own `try`/`catch`, logged but never re-thrown — then unconditionally
  removes the D1 row, so an RPC failure never leaves a chat undeletable.
- `GET /:id/get-messages` and `GET /:id/ws` both resolve an ownership-scoped
  Durable Object stub (confirming the identity owns the chat before ever
  addressing it) and forward the original request unchanged; `AIChatAgent`
  itself decides from the request shape whether to answer the message-history
  `GET` or perform the WebSocket upgrade.

Every route resolving a stub re-reads the chat's current `route` and the
owner's current `business` segment from D1 on **every** request and threads
both into `getAgentByName()`'s `props`, delivered fresh to `onStart()` each
time the Durable Object wakes — there is no cache to invalidate when either
value changes between turns. Ownership checks scope the `owner_email`
predicate inside the same `SELECT` as the ID lookup, so "this chat doesn't
exist" and "this chat exists but isn't yours" are structurally the same
`404` result.

`ChatAgent` (`src/worker/agent/chat-agent.ts`) itself stays close to minimal:
`onStart()` captures the owner identity, route, and business segment;
`onChatMessage()` builds a `streamText()` call against
`resolveDynamicRouteModelId(this.route, this.env)`'s resolved model ID, this
chat's persisted messages, and the registered tools and skills (below), then
wraps its `onFinish` callback to also record usage and touch the chat's
recency/title. `destroy()` is the one other method it overrides — notifying
connected clients with a `chat_removed` frame and a dedicated close code
before delegating to the SDK's own teardown.

### Governed model selection and metadata-driven routing

`resolveDynamicRouteModelId()` (`src/worker/chats/route.ts`) is the single
function that turns a validated `"basic"`/`"reasoning"` literal into the real
`dynamic/<route-name>` model ID, read from `env.AI_GATEWAY_ROUTE_BASIC`/
`env.AI_GATEWAY_ROUTE_REASONING` — Worker vars sourced from Terraform outputs,
never hard-coded, so renaming a route in Terraform needs no code change.
`workers-ai-provider` forwards any model ID starting with `"dynamic/"`
straight to `env.AI.run()`'s run path with no adapter code; `streamText()`'s
own streaming decoder already handles both Workers AI's native and a dynamic
route's OpenAI-compatible wire shapes transparently.

Each of the two dynamic routes (Terraform: `cloudflare_ai_gateway_dynamic_routing.basic`/
`.reasoning`) carries a `business-check` conditional element: a caller whose
segment is exactly `"field"` resolves to that route's normal model; every
other caller (a different segment, or none assigned yet) is routed through a
`rate` element (`key = "metadata.business"`, keyed per segment rather than
per user) to a stronger, pricier model, falling back to the cheap model if
that segment's own bucket is briefly exhausted. The gateway itself carries a
spend limit partitioned the same way (`metadata.business`), so each segment
gets its own independent budget pool. `business` reaches AI Gateway as
`gateway.metadata.business`, attached in `onChatMessage()` right alongside a
fresh per-turn `correlationId` (below) — AI Gateway accepts at most five
metadata entries per request.

Because a route can resolve to one of two models depending on the caller's
segment, the immediate local cost estimate (`src/worker/usage/pricing.ts`'s
`tierForBusiness()`) mirrors the same `business === "field"` branch the
Terraform conditional encodes, so a turn's pre-reconciliation estimate is
priced against the model the route will actually resolve to for that caller.
This is an explicit snapshot of the routes' current configuration, kept in
sync by hand — `reconcileUsage()`'s later upgrade to AI Gateway's own logged
model/cost is always correct regardless of drift.

### Voice-to-prompt dictation

`POST /api/transcribe` (`src/worker/routes/transcribe.ts`) is a plain Hono
route with no Durable Object and no D1 write — a one-shot, request/response
call is a better fit for speech-to-text than a WebSocket round trip.
`transcribeRequestBodyLimit` rejects an oversized request before any bytes
are read; `validateContentType()`/`validateAudioBytes()`
(`src/worker/transcribe/validation.ts`) reject a non-`audio/*` or empty body;
`transcribeAudio()` (`src/worker/transcribe/transcription.ts`) base64-encodes
the bytes and calls `env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio },
{ gateway: { id } })` directly — the same AI Gateway every chat turn uses, so
a dictation call appears in its overall request log rather than either
dynamic route, since this call passes a literal model ID.

`src/client/composables/useVoiceDictation.ts` is the one place this demo
speaks `MediaRecorder`/`navigator.mediaDevices`: `start()` requests
microphone access and records with no explicit `mimeType`, so the browser's
own default capture container is used unmodified — Workers AI transcribes it
exactly as accurately as a client-side-converted file of the same utterance,
so no re-encoding step exists. A five-state lifecycle
(`"idle" | "requesting-permission" | "recording" | "transcribing" | "error"`)
distinguishes a pending permission prompt from active recording; a denied
permission or a failed transcription both set a specific, human-readable
error, and calling `start()` again clears it. `ChatComposer.vue`'s
`onTranscribed()` callback appends the transcript to whatever the composer
already holds — dictation never replaces a typed draft and never auto-submits.

### The cost ledger

`env.AI.aiGatewayLogId` — the binding's own "log ID of the most recent call"
property — is only populated when the model argument is a literal model ID;
it is `null` for every dynamic-route call, which is every real turn in this
demo. So `onChatMessage()` mints a fresh `crypto.randomUUID()` as
`correlationId` before calling `streamText()`, attaches it as
`gateway.metadata.correlationId`, and `findLogByCorrelationId()`
(`src/worker/ai-gateway/logs.ts`) later queries AI Gateway's logs-list REST
endpoint by that value — the sole place this demo calls the Cloudflare REST
API directly instead of a binding, since the `AiGateway` binding class
exposes only `getLog(id)`/`patchLog(id)`/`getUrl()`, none of which can list
logs by metadata. This is also why the Worker needs a `CLOUDFLARE_API_TOKEN`
secret at runtime, not just the `AI` binding.

The write is two-phase and asynchronously reconciled:

1. **Immediate write.** The moment `onFinish` fires, `recordTurnUsage()`
   inserts a `chat_usage` row from a local per-model pricing-table estimate,
   `cost_source = 'estimated'`, and schedules the first reconciliation attempt
   via `this.schedule(10, "reconcileUsage", payload)` — the Agents SDK's own
   durable, Durable-Object-eviction-safe scheduling primitive, not
   `ctx.waitUntil()`, whose lifetime is tied to the now-finished request.
2. **Reconciliation.** `reconcileUsage()` queries the logs-list endpoint by
   `correlationId`. A match upgrades the row in place to
   `cost_source = 'gateway'` with the real logged tokens/cost and the row's
   own log ID. No match increments a bounded attempt counter and reschedules
   at +15s, up to three attempts total (~40s worst case); once exhausted, the
   row is left `"estimated"` permanently — a legitimate, visibly labeled
   outcome, not an error state. A failed-but-logged turn (a genuine AI
   Gateway error) still produces a correlatable log row and reconciles the
   same way as a healthy one.
3. **Safe against a deleted target.** A scheduled reconciliation whose chat
   was deleted in the meantime detects the missing row and exits cleanly
   rather than throwing.

`ChatAgent.State.usage` is an aggregate projection — always re-derived from
D1 (`UsageRepository.aggregateForChat()`), never independently mutated — so a
connected client's cost readout updates automatically via `setState()`, and a
client that connects later gets the current number on connect with no extra
fetch. A `usage_reconciled`/`usage_reconcile_exhausted` broadcast rides
alongside the `setState()` call purely so the UI can play a one-time
"Estimated → AI Gateway" transition animation, since a client cannot
otherwise tell "a new turn happened" from "an estimate was just confirmed" by
diffing `state` alone. The sidebar, which has no live connection to every
listed chat, instead reads the same aggregate over `GET /api/chats`.

### Tools: `writeMarkdown` and `getUrl`

Both tools are ordinary `ai`-SDK `tool()` definitions (a Zod input schema and
an `execute()` function) passed into `streamText()`'s `tools` option — no
hand-rolled function-calling loop. `stopWhen: stepCountIs(4)` lets a
successful tool call be followed by the model actually responding to its
result, rather than the SDK's own one-step default silently stopping the
instant a tool call is emitted.

`createWriteMarkdownTool()` (`src/worker/agent/tools/write-markdown.ts`) is
called with the chat's own bucket/database/ID/correlation-ID collaborators
rather than reading a global binding — the underlying `writeMarkdownFile()`
never imports a Cloudflare binding type, so it is unit-tested with plain
in-memory fakes. It writes to R2 before inserting the `chat_files` row, and
deletes the object it just wrote if the D1 insert fails, so a partial failure
never leaves an orphaned, undownloadable-looking row or a downloadable-looking
row with no backing content. Every failure path — an unusable filename,
empty/oversized content, an R2 or D1 error — returns a structured
`{ success: false, error }` result instead of throwing, so the model's next
step can explain the failure in its own reply rather than the turn aborting.

`getUrl` has a genuine security boundary `writeMarkdown` does not: reaching
arbitrary destinations on the public Internet. Its `execute()` calls
`env.LOADER.get("get-url-tool", ...)` (the `worker_loaders` binding) to run a
fixed sandboxed module inside a cached Dynamic Worker — cached by name, since
the sandboxed code never changes — whose `globalOutbound` is bound to
`EgressGateway` (`src/worker/egress/gateway.ts`), a `WorkerEntrypoint`
intercepting every outbound request the sandbox attempts. `EgressGateway`
checks the destination hostname against a small, exact-match allow-list
(`src/worker/egress/allowlist.ts`) and only forwards an allowed request to
the real network — this is the actual enforcement point; `validateUrlFloor()`
(scheme must be http/https, hostname must not look internal) is a
defense-in-depth floor checked earlier, not the primary control. The
sandboxed Dynamic Worker receives no bindings beyond `globalOutbound`, so it
cannot reach D1, R2, or anything else this Worker can. A blocked destination
surfaces to the sandboxed module as a thrown exception (not a non-2xx
response), which it catches and re-encodes as an ordinary `403` so the outer
tool — and, in turn, the model — can explain the refusal instead of the
stream crashing; the tool distinguishes "blocked" from "genuinely failed" by
checking for exactly that status code, not by matching an error string.

`ChatAgent.onChatMessage()` reaches the gateway stub directly from inside the
Durable Object via `this.ctx.exports.EgressGateway({ props })` — no top-level
Worker `fetch()` handler needs to know this tool exists.

### Skills

`buildSkillRegistry()` (`src/worker/skills/registry.ts`) is the entire
integration with the Agents SDK's released `agents/skills` mechanism: one
shared `r2(bucket, { prefix: "skills/enterprise/" })` source plus, when the
calling chat's owner is known, a second `r2(bucket, { prefix:
"skills/personal/<owner>/" })` source scoped to that one owner — a personal
source can structurally never see another owner's directory, so isolation
needs no application-level filter. `ChatAgent.onChatMessage()` awaits
`registry.systemPrompt()` to completion before calling `registry.tools()`:
only `systemPrompt()`'s own snapshot triggers the registry's R2 listing, so
calling both concurrently would race `tools()` ahead of the load and
silently return no tools at all. The catalog costs nothing in the prompt
until a task matches it — `systemPrompt()` returns only each skill's
name/description, never its full instruction body, which only reaches a
prompt once the model actually calls `activate_skill` for that one skill.

A skill's D1 row (`src/worker/skills/repository.ts`) exists only so
`GET`/`DELETE /api/skills` and `/api/admin/skills` can list and remove a
skill and clean up its R2 object; `ChatAgent` never reads that table at turn
time — the model-visible catalog is `agents/skills`'s own R2 listing.
`buildSkillMarkdown()` (`src/worker/skills/validation.ts`) always generates
the `SKILL.md` frontmatter from the request body's own validated fields
rather than trusting an uploaded file's embedded frontmatter. Adding a skill
from a URL reuses `getUrl`'s own `validateUrlFloor()` but fetches directly
from the Worker, not through the Dynamic Worker sandbox: ingesting a skill is
a single, authenticated, owner/admin-initiated action, not a repeatable,
model-chosen destination inside every turn — structurally closer to
`writeMarkdown`'s "no untrusted egress to control" than to `getUrl`'s.

### Export

`GET /api/chats/:id/export` and `GET /api/chats/:id/files/:fileId/export`
(`src/worker/routes/chats.ts`) build a Markdown document server-side, because
both sources of truth — the transcript and the cost ledger — are already
server-side: the transcript lives in the Durable Object's own SQLite
storage, and the browser only ever sees rendered turns, never raw message
parts. The chat export forwards a synthetic request ending in
`get-messages` to the same Durable Object stub the ordinary history route
already uses — one transcript-reading mechanism, exercised for two purposes.
Two pure functions, `src/worker/export/chat-markdown.ts` and
`file-markdown.ts`, take already-fetched data and return a string with no
binding involved, so they are unit-tested independently of any HTTP route.
`resolveToolName()`/`formatToolPart()` render every tool call the same way
except `activate_skill`, which gets a distinct "Skill activated" label. The
per-file export reads `UsageRepository.findByCorrelationId(file.correlationId)`
— an exact-match lookup, not a timestamp guess — so its "cost context of the
producing turn" section always names the literal turn that wrote that file.
Both export routes are `<a href>` elements relying on the browser's existing
Access session cookie, with a server-set `Content-Disposition` header naming
the download, exactly like the underlying file-download route.

### Testing approach

Every test that exercises a real turn substitutes a fake `env.AI` binding
rather than calling a real Workers AI model, extending this repository's
`demos/ai-chat` pattern to a Durable Object: `agents`/`@cloudflare/ai-chat`
import `cloudflare:workers` at module scope, so `ChatAgent` cannot be loaded
into the plain-Node unit-test project at all — every test exercising it is an
integration test against the real `workerd` runtime, calling internal
methods directly via `runInDurableObject()` where a real 10s/15s schedule
delay would otherwise make a test slow. The cost-reconciliation REST call and
the browser's `MediaRecorder`/microphone APIs are substituted with
deterministic fakes the same way. Two binding-adjacent surfaces are
deliberately **not** faked: `worker_loaders`/`EgressGateway` has no
account-level proxy step at all, so its allow-listed test case makes one
genuine outbound HTTPS request to a stable, real Cloudflare-owned hostname —
correct whether or not this demo has ever been deployed; a dynamic AI Gateway
route, by contrast, does not exist in a fresh, undeployed checkout, so every
model-routing test asserts on the exact `dynamic/<route-name>` model ID
string sent to the fake binding instead of calling a real, deployed gateway.
Observing both real AI Gateway routes resolve to their configured models
against a live account is a manual step in `README.md`'s Post-Deploy
Verification.

### Observability

`cloudflareLogger()` provides request-scoped structured logging on every
request: `chat_created`, `chat_connected`, `chat_route_changed`,
`chat_deleted`, `transcription_completed`, `admin_user_metadata_updated`,
`chat_file_downloaded`, `egress_gateway_decision`, `skill_created`,
`skill_deleted`, `chat_exported`, and `chat_file_exported`, among others.
`ChatAgent`'s own background failure paths (a failed recency touch, a failed
title generation) log outside the Hono request context, the same way a
Durable Object logs in `demos/chat`. AI Gateway's own dashboard — per-route
request volume, cost analytics, and rate/spend-limit hits — is the
operator-facing cross-check for the cost ledger and metadata-driven routing.
Terraform enables Workers Logs at 100% sampling and traces at 10% sampling.

## Further Reading

- [`docs/06-AGENTIC-CHAT.md`](../../docs/06-AGENTIC-CHAT.md) — the full
  design, requirements, and data flow this demo implements.
- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Agents SDK: chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Agents SDK: schedule tasks](https://developers.cloudflare.com/agents/api-reference/schedule-tasks/)
- [Agents SDK: skills](https://developers.cloudflare.com/agents/api-reference/skills/)
- [AI Gateway dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [AI Gateway rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [AI Gateway custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)
- [AI Gateway logs](https://developers.cloudflare.com/ai-gateway/observability/logging/) and the [logs-list API reference](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/)
- [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) and [getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)
- [Dynamic Workers: egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)
- [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)
- [AI SDK: tools](https://ai-sdk.dev/docs/foundations/tools) and [tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [AI SDK: UI message persistence](https://ai-sdk.dev/docs/ai-sdk-ui/message-persistence)
- [Vercel AI SDK: streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Workers AI: speech-to-text models](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [MediaRecorder API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [D1](https://developers.cloudflare.com/d1/) and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vue 3: Composables](https://vuejs.org/guide/reusability/composables.html)
