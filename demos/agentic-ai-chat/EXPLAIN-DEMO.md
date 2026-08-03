# Agentic Chat — What This Demo Teaches

This demo is the curriculum's introduction to the Agents SDK, built feature by feature rather than layer by layer. The full plan — every user story, design decision, spike, and phase — lives in [`docs/06-AGENTIC-CHAT.md`](../../docs/06-AGENTIC-CHAT.md); this file only covers what **this checkout** (Phase 1, Scaffolding, and Phase 2, Core Agentic Chat) actually implements. Later phases will extend this file as their own features ship.

## What Phase 1 (Scaffolding) Demonstrates

- **A demo built and tagged in independently reviewable phases.** Unlike every earlier demo in this curriculum, `docs/06-AGENTIC-CHAT.md` breaks this build into one user story per phase, each tagged in git (`agentic-chat/phase-01-scaffolding`, `agentic-chat/phase-02-core-chat`, …) so any two phases can be diffed directly. This phase's job is to prove the baseline — deployable, Access-gated, tested, and empty of the actual chat feature — so every later phase's diff is pure feature work, not scaffolding noise.
- **Spikes before features.** Six spikes (`spikes/00`–`spikes/05`) answered the platform's riskiest open questions — whether `AIChatAgent` composes with a hand-built Vue client, which Workers AI models survive a dynamic route's model node, how Dynamic Workers' `globalOutbound` gateway actually wires up, whether the Agents SDK's skills mechanism is `AIChatAgent`-agnostic, the real speech-to-text input contract, and how to correlate a dynamic-route call back to its AI Gateway log row — *before* any feature code assumed an answer. This phase's Terraform and Wrangler configuration is written against those confirmed findings, not assumptions; see each spike's own `REPORT.md`.
- **Cloudflare Access pinning `audience`, and why that is not always the default.** Every demo in this repo requires the whole hostname to sit behind Cloudflare Access, but not every demo pins the Access application's `audience` claim. This one does, because every chat this demo will hold is sensitive, billable AI conversation history — accepting a token minted for *any other* Access application in the same Zero Trust team (every application in a team shares the same JWKS) is not an acceptable trade-off here, unlike `demos/todo-app`'s deliberately simpler posture. Because `cloudflareAccess()` reads its `audience` option once at Worker module-load time — before any request-scoped `env` binding exists — the real Access application's AUD tag cannot be threaded in as an ordinary `wrangler.jsonc` var the way `CLOUDFLARE_TEAM_DOMAIN` is. It is threaded in as a Vite build-time define instead (`VITE_ACCESS_AUDIENCE`, read from the `access_audience` Terraform output only at `npm run deploy` time — see `package.json`'s `deploy:worker:publish` script and `src/worker/middleware/access.ts`).
- **A D1-flagged application role, kept separate from Cloudflare Access.** "Administrator" is a `users.is_admin` column, not a second Access application or policy — Access has no concept of this demo's business role, and role-based authorization is correctly an application-layer concern (AGENTS.md, "Admin Authorization Is An Application Concern"). `UserRepository.ensureUser()` is the one place this is decided: every verified sign-in idempotently upserts a `users` row, and the identity matching the Worker's `ADMIN_EMAIL` variable is always re-forced to `is_admin = 1`, regardless of prior D1 state — so the role survives a redeploy or a partial teardown that left a stale row behind, without needing a separate bootstrap script or manual dashboard step.
- **Infrastructure provisioned ahead of the code that uses it.** This phase's Terraform already provisions the full AI Gateway and both of its dynamic routes (`agentic-chat-basic`, `agentic-chat-reasoning`), confirmed fully Terraform-manageable by Spike B — even though no Worker route calls them yet. Provisioning them now means a later phase's diff is application code only, not a second infrastructure change.

## What Phase 2 (Core Agentic Chat, US-1) Demonstrates

- **The Agents SDK's `AIChatAgent` as the mechanism for a persistent, resumable, per-entity AI conversation.** `src/worker/agent/chat-agent.ts`'s `ChatAgent extends AIChatAgent<Env, unknown, ChatAgentProps>` gets message persistence, resumable streaming, and WebSocket sync for free — the class only has to implement `onStart()` (capture the routed owner identity) and `onChatMessage()` (answer one turn). This is deliberately not a hand-rolled Durable Object the way `demos/chat`'s `ChatRoom` is: that demo's lesson was Durable Object fundamentals; this one's is the SDK built on top of them (AGENTS.md's "Why `AIChatAgent`, Not A Hand-Rolled Durable Object", `docs/06-AGENTIC-CHAT.md` Section 6.2).
- **Per-chat instancing via `getAgentByName()`, not `routeAgentRequest()`'s URL convention.** `src/worker/routes/chats.ts` extracts a chat id from `/api/chats/:id/...`, confirms in D1 that the verified Access identity owns it, and only then calls `getAgentByName(env.CHAT_AGENT, id, { props: { ownerEmail } })` — the same custom-routing shape Spike A proved out. The owner identity reaches the Durable Object exclusively through this `props` argument, delivered to `onStart()`; it is never read from anything the client's own request body or WebSocket frames could set.
- **A vue-only client speaking the Agent WebSocket protocol directly, through `agents/client`'s framework-agnostic `AgentClient`, not the React-only `agents/react` hooks.** `src/client/composables/useChatAgent.ts` is the **one** place this demo builds the `cf_agent_use_chat_request`/`cf_agent_use_chat_response` wire frames by hand (reverse-engineered by Spike A, since no framework-agnostic helper is exported for it) and decodes the streamed body's bare, back-to-back UI-message-stream JSON objects (`src/client/lib/ui-message-stream.ts` — this is *not* classic SSE `data:` framing, a real surprise Spike A had to correct). Every Pinia store and component consumes this composable's reactive surface (`turns`, `connectionStatus`, `isStreaming`, `send()`); nothing else in the client ever touches `AgentClient` or a raw `WebSocket`.
- **A chat's history survives a page reload because it lives in the Durable Object's own SQLite storage, not browser memory.** `useChatAgent`'s `connect()` first calls `GET /api/chats/:id/get-messages` — forwarded straight to the Durable Object's own built-in `onRequest` handler (`@cloudflare/ai-chat`'s `AIChatAgent` answers any GET request whose path ends in `get-messages` with `this._loadMessagesFromDb()`; see `docs/DECISIONS.md` #18) — before ever opening the live WebSocket. Reloading the page re-runs this same fetch, so the transcript reappears from durable storage every time, exactly matching US-1's acceptance criterion.
- **Ownership rejection is `404`, not `403`, to avoid confirming another user's chat id exists.** `ChatRepository.findOwned()` scopes the `owner_email` predicate *inside* the same `SELECT` rather than checking it afterward, so "this chat doesn't exist" and "this chat exists but isn't yours" are structurally the same result — `src/worker/routes/chats.ts` can't leak the distinction even if it wanted to.
- **A model call routed through AI Gateway, deliberately not yet through a dynamic route.** `chat-agent.ts` calls a single hard-coded catalog model (`@cf/ibm-granite/granite-4.0-h-micro`, reused from `demos/ai-chat`'s verified catalog) via `workers-ai-provider`'s `gateway: { id: this.env.AI_GATEWAY_ID }` option — proving the `AIChatAgent` + `streamText()` + AI Gateway chain end to end with the simplest possible model wiring. Phase 4 replaces this literal model ID with a client-selected `"basic"`/`"reasoning"` AI Gateway *dynamic route* name (the two routes Phase 1's Terraform already provisions, unused until then) — a deliberately separate concern from proving the mechanism itself.
- **Faking a binding a Durable Object reads, not just one a Worker's `fetch()` handler reads.** `tests/integration/chat.test.ts` drives a real WebSocket chat turn against the real `ChatAgent` Durable Object with no real Workers AI call, by substituting `env.AI` (imported from `cloudflare:workers`) for the duration of one test — confirmed to reach `this.env.AI` inside the Durable Object itself, since `@cloudflare/vitest-pool-workers` runs the whole test file's Worker script and every Durable Object it creates in one shared in-process `workerd` instance (`docs/DECISIONS.md` #17). This extends `demos/ai-chat`'s "inject a fake `Ai`" pattern to a Durable Object for the first time in this repo.

## How It Works

### Data model

`migrations/0001_create_users_and_chats.sql` defines two tables:

```sql
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT,
  route TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX chats_owner_email_idx ON chats (owner_email);
```

`chats` is indexed on `owner_email` and, as of this phase, is what `ChatRepository` (`src/worker/chats/repository.ts`) reads and writes to instance a `ChatAgent` Durable Object per row and enforce ownership. `title`/`route` stay nullable until Phase 3's auto-titling and Phase 4's route selection exist.

### Routing and the Access model

Every path on this hostname requires authentication — there is no public route (`src/access-policies.ts`), matching `demos/todo-app`/`demos/chat`'s whole-hostname pattern rather than `demos/url-shortener`'s mixed public/admin one. `src/worker/index.ts` applies `accessMiddleware` (`src/worker/middleware/access.ts`) to every `/api/*` route before mounting `/api/me`; page routes are served directly by the `ASSETS` binding's `single-page-application` fallback, with Access enforcing authentication at the edge before the request ever reaches the Worker or that fallback.

### The `/api/me` route is also the admin-bootstrap path

`src/worker/routes/me.ts` is deliberately the *only* place `UserRepository.ensureUser()` (`src/worker/users/repository.ts`) runs. There is no separate registration endpoint and no one-time bootstrap script: every call to `GET /api/me` — which the client always makes once on load (`src/client/stores/session.ts`) — upserts the verified identity's D1 row and idempotently corrects its `is_admin` flag to match whether that identity is the configured `ADMIN_EMAIL`. The repository issues two structurally different SQL statements for this, not one parameterized branch, so the intent is legible directly from the SQL text: an ordinary identity's statement only ever inserts a fresh row (`ON CONFLICT (email) DO NOTHING`, never touching an existing row's flag — preserving a manual promotion a future admin console might make to someone else), while the administrator identity's statement always re-applies `is_admin = 1` (`ON CONFLICT (email) DO UPDATE SET is_admin = 1`) no matter what was there before.

### The `ChatAgent` Durable Object and its Worker-side routing

`src/worker/routes/chats.ts` exposes three routes mounted at `/api/chats`:

- `POST /` creates a chat: a server-generated UUID, a D1 directory row, and nothing else — the `ChatAgent` Durable Object for that id does not need to exist yet; it is created lazily by `getAgentByName()` the first time anything addresses it.
- `GET /:id/get-messages` and `GET /:id/ws` both first call `ownedAgentStub()`, which does a single ownership-scoped D1 lookup (`ChatRepository.findOwned()`) and only then resolves the Durable Object stub, threading the verified identity in as `props`. Both routes forward the original request to that stub's `fetch()` unchanged — `AIChatAgent` itself decides, from the request shape, whether to answer the message-history GET or perform the WebSocket upgrade.

`ChatAgent` (`src/worker/agent/chat-agent.ts`) itself is minimal by design: `onStart()` captures the owner email; `onChatMessage()` builds a `streamText()` call with a hard-coded model, this chat's persisted `this.messages` (via `convertToModelMessages()`), and the turn's `abortSignal`, then returns `result.toUIMessageStreamResponse()`. Everything else — message persistence, resumable streaming, WebSocket framing, MCP-server bookkeeping — is `AIChatAgent`'s own responsibility.

### The wire protocol `useChatAgent.ts` speaks

A client sends one frame per turn and receives one or more response frames back, correlated by a request id:

```json
// client -> server
{ "type": "cf_agent_use_chat_request", "id": "<uuid>", "init": { "method": "POST", "body": "{\"messages\":[...],\"trigger\":\"submit-message\"}" } }

// server -> client, one or more times, then a final done:true
{ "type": "cf_agent_use_chat_response", "id": "<same uuid>", "body": "<raw chunk text>", "done": false }
```

The crucial, easy-to-miss detail (Spike A, `docs/06-AGENTIC-CHAT.md` Section 9): `body` is **not** `data: {...}\n\n` SSE framing. It is the AI SDK's `toUIMessageStreamResponse()` body text forwarded byte-for-byte — bare, back-to-back JSON objects with no separator guaranteed, and a JSON object can straddle two separate `body` deltas. `UiMessageStreamDecoder` (`src/client/lib/ui-message-stream.ts`) buffers across chunks and scans for balanced `{`/`}` pairs (tracking string literals so a brace inside a quoted value is never mistaken for structural JSON) to recover each complete part as it becomes available.

### Testing this phase without a real model call

Every worker-side test that exercises a real turn substitutes a fake `Ai` binding rather than calling the real Workers AI model — following `demos/ai-chat`'s own pattern, extended here to a Durable Object (`docs/DECISIONS.md` #17). `tests/integration/fixtures.ts`'s `withFakeAi()` swaps `env.AI` for the duration of one test and restores it afterward; the fake still returns the same raw Workers AI SSE stream shape `workers-ai-provider` expects, so the real `AIChatAgent` + `streamText()` + `workers-ai-provider` chain runs unmodified end to end, with only the model itself faked. The client-side composable's own tests (`useChatAgent.test.ts`) go one level further down: they stub the global `WebSocket` constructor with a small, controllable double, so `AgentClient` (which falls back to the global `WebSocket` when given no override) drives its real reconnect/state machinery against a socket the test can open, message, and close on command — no real network, and no need to mock `agents/client` itself.

### Observability

`cloudflareLogger()` provides request-scoped structured logging on every request, including a `chat_created` entry (chat creation) and a `chat_connected` entry (every WebSocket upgrade). Terraform enables Workers Logs at 100% sampling and traces at 10% sampling on the Worker resource — the same defaults every demo in this repo uses.

## Further Reading

- `docs/06-AGENTIC-CHAT.md` — the full feature-by-feature implementation plan this demo follows.
- `spikes/00-aichatagent-basics/REPORT.md` through `spikes/05-workers-ai-speech-to-text/REPORT.md` — the platform findings this and every later phase are built against.
- `docs/DECISIONS.md` #17/#18 — this phase's own two new platform findings (faking a binding a Durable Object reads; `AIChatAgent`'s built-in history endpoint).
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [D1](https://developers.cloudflare.com/d1/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [AI Gateway dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Agents SDK: chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Vercel AI SDK: streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
- [Hono](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Vue 3: Composables](https://vuejs.org/guide/reusability/composables.html)
