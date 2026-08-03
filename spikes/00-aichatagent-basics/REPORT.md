# Spike A Report

Run 2026-08-03 against the real Cloudflare account (`spike-00-aichatagent-basics` deployed to
`https://spike-00-aichatagent-basics.adrian-hall-internal-demo.workers.dev`, fronted by a
bypass-all Access application). All findings below are either **live-observed** (an actual
request/response over the deployed Worker) or **source-verified** (read directly from the
installed package's shipped `dist/*.d.ts`/`dist/*.js` — a real, current primary source, not
guessed from docs, which lag the packages' actual current shipped behavior). Each finding says
which.

## 1. Exact package versions used (source-verified: `npm view`, then actually installed)

| Package | Version | Notes |
| --- | --- | --- |
| `agents` | `0.20.1` | |
| `@cloudflare/ai-chat` | `0.10.1` | |
| `ai` | `7.0.48` | |
| `workers-ai-provider` | `4.0.0` | |
| `zod` | `4.4.3` | peer dep of `ai` (`^3.25.76 \|\| ^4.1.8`) |
| `wrangler` | `4.115.0` | pinned, matches every other demo in this repo |
| `typescript` | `^7.0.2` | matches every other demo in this repo, not AGENTS.md's stale `^6.0.3` baseline |

**Finding — installing `@cloudflare/ai-chat` pulls in `react` and `@ai-sdk/react` even for
server-only, Vue-adjacent use.** `@cloudflare/ai-chat`'s `package.json` declares
`@ai-sdk/react`/`react` as required (non-optional) `peerDependencies`, with no
`peerDependenciesMeta` marking them optional (unlike `agents`, which does mark its own
`@ai-sdk/react`/`react`/etc. peers optional). A plain `npm install` in this spike — which imports
only `@cloudflare/ai-chat`'s main entry (`AIChatAgent`), never `@cloudflare/ai-chat/react` —
still installed `react@19.2.8` and `@ai-sdk/react@4.0.51` into `node_modules` because npm 7+
auto-installs missing peers. This costs nothing at runtime (the main entry's compiled bundle,
confirmed by reading `dist/index.js`, never imports React — only `dist/react.js`, a 2-line
re-export of `agents/chat/react`, does), but it is real `node_modules` weight and a real
dependency-tree entry for a Vue-only demo. **Recommendation for the real demo:** install
`@cloudflare/ai-chat`, `agents`, `ai`, `workers-ai-provider`, `zod` as usual; do not import
`@cloudflare/ai-chat/react` or `agents/react`/`agents/chat/react` anywhere (Section 6.2a already
mandates this); do not worry about the transitively-installed `react`/`@ai-sdk/react` packages
themselves — they are inert, not a security or bundle-size concern for the deployed Worker (they
are never imported by the Worker's own module graph, and `wrangler deploy`'s bundler only
includes what is actually imported).

## 2. `wrangler.jsonc` shape (live-verified: this is what actually deployed and ran)

```jsonc
{
  "name": "spike-00-aichatagent-basics",
  "main": "./src/index.ts",
  "compatibility_date": "2026-07-29",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "CHAT_AGENT", "class_name": "ChatAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChatAgent"] }],
  "ai": { "binding": "AI", "remote": true }
}
```

This matches `docs/06-AGENTIC-CHAT.md`'s prediction exactly: DO binding + `new_sqlite_classes`
migration + `ai` binding + `nodejs_compat`. No surprises here.

**Finding — this environment's installed `wrangler@4.115.0` / local `workerd` binary rejected
`compatibility_date: "2026-08-03"`** (today, at spike time) with `This Worker requires
compatibility date "2026-08-03", but the newest date supported by this server binary is
"2026-07-29"`, both for `wrangler dev` and (initially) `wrangler deploy` before the date was
lowered. `2026-07-29` is what this spike ships. Other demos in this repo declare later dates
(`2026-07-31`) with the same pinned `wrangler` version, so this ceiling may be specific to when
each demo's `npm install` last ran (workerd binaries update independently of wrangler's own
semver patch releases within a version range) rather than a hard fact about `4.115.0` — worth a
fresh `npm view wrangler` / reinstall check before Scaffolding rather than copying either date
blindly.

## 3. The chain works end to end (live-verified)

`ChatAgent extends AIChatAgent<Env, unknown, ChatAgentProps>`, `onChatMessage` calling
`streamText({ model: workersai(modelId, { gateway: { id } }), messages: await
convertToModelMessages(this.messages), onFinish })`, returning
`result.toUIMessageStreamResponse()`, produced a real, correctly-streamed model response over a
raw WebSocket connection speaking the `AIChatAgent` wire protocol (Section 5 below). No dead
ends, no undocumented required steps beyond the two corrections below.

**Correction — `convertToModelMessages()` is `async` in `ai@7.0.48`** (`Promise<ModelMessage[]>`,
confirmed from `node_modules/ai/dist/index.d.ts`), not synchronous. `docs/06-AGENTIC-CHAT.md`
does not currently show a code sample, but the Agents SDK skill's own reference example
(`references/streaming-chat.md`) already shows `await convertToModelMessages(...)` — this spike's
first draft omitted the `await` and got a clean `tsc` type error (`Promise<ModelMessage[]>` is not
assignable to `ModelMessage[]`) rather than a silent runtime bug, which is worth calling out
positively: this is a case where TypeScript strictness caught the exact mistake docs/06 would
otherwise have silently reproduced into Phase 2 code.

**Correction — an AI Gateway `id` passed via `workers-ai-provider`'s `gateway: { id }` option
must already exist; only the literal id `"default"` auto-provisions.** Cloudflare's own docs
state "AI Gateway automatically creates a default gateway on the first authenticated request,"
which reads as if any id would auto-provision. Passing an arbitrary unprovisioned id
(`spike-00-aichatagent-basics`) through `workers-ai-provider` failed live with `AI_APICallError:
2001: Please configure AI Gateway in the Cloudflare dashboard` — the gateway had to be created
first via the AI Gateway REST API (`POST /accounts/{account}/ai-gateway/gateways`) before the
chain worked. **This directly confirms Spike B's scope is required, not optional**: the two named
dynamic-route gateways (Section 6.3, `agentic-chat-basic`/`agentic-chat-reasoning`) must be
provisioned as real infrastructure (Terraform, if the provider supports it, or a
`generate-wrangler`-adjacent provisioning script) before Phase 4 can assume they exist — no code
path in this demo can rely on auto-provisioning the way `"default"` does.

## 4. Streaming shape: `workers-ai-provider` normalizes to the AI SDK's UI-message-stream
   protocol, but does **not** lift inline `<think>` tags to a distinct reasoning part
   (live-verified, both models)

Both catalog models (`@cf/ibm-granite/granite-4.0-h-micro`, non-reasoning; and
`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, reasoning via inline `<think>` tags — same two
entries and same reasoning mechanism `docs/DECISIONS.md` #10 already verified for demo 5's raw
`env.AI.run()` path) were driven through the identical `onChatMessage` code path. Both streamed
the same clean, uniform AI SDK v5 UI-message-stream event sequence:

```
start → start-step → text-start → text-delta (×N) → text-end → finish-step → finish
```

No `choices`/`response`/raw-Workers-AI-native shape differences leaked through — confirming
`workers-ai-provider` **does** absorb the raw-provider streaming-shape divergence demo 5 had to
hand-roll its own adapter registry for (`docs/DECISIONS.md` #10's "Streaming chunk shape is not
determined by the model's declared input type" finding does not resurface here; that finding was
specific to calling `env.AI.run()` directly).

However — the DeepSeek model's `<think>...</think>` block arrived as **ordinary inline text**
inside the same `text-delta` stream as the answer, exactly as it does at the raw Workers AI layer.
There is **no distinct `reasoning`/`reasoning-delta` UI message part** for this model through
`workers-ai-provider`. Verbatim excerpt from the live response (`probe-reasoning-1`):

```
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"<think>"}
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"\n"}
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"Okay"}
... (ordinary text deltas containing the whole <think> block) ...
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"</think>"}
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"\n\n"}
{"type":"text-delta","id":"Ft0won4n3vU3Nb8J","delta":"The"}
... (the real answer, still the same text part) ...
```

**Correction to `docs/06-AGENTIC-CHAT.md`'s implicit assumption**: this demo cannot treat "route
through `workers-ai-provider`" as a substitute for demo 5's `inline-think-tags` splitting logic
(`src/worker/chat/reasoning.ts` in `demos/ai-chat`). Phase 2 (US-1, core agentic chat) must reuse
that same `<think>`-tag-splitting approach client- or server-side for this specific model if a
"Thinking" panel is wanted, exactly as demo 5 did — `workers-ai-provider` only normalizes the
*transport* shape (SSE UI-message-stream vs. raw Workers AI chunking), not the *content*
placement of a model's own inline reasoning markers. (Whether `@cf/zai-org/glm-4.7-flash`'s or
`@cf/google/gemma-4-26b-a4b-it`'s `reasoning-field` mechanism — a distinct field at the raw
Workers AI layer, per demo 5's catalog — surfaces as a distinct `reasoning`/`reasoning-delta` UI
part through `workers-ai-provider` was not tested here and should be spot-checked before Phase 2
assumes either answer.)

## 5. The exact `AIChatAgent` WebSocket wire protocol (source-verified + live-verified)

Neither `agents/react`'s `useAgentChat` nor any framework-agnostic equivalent is exported for
driving a chat turn — the actual client-side protocol construction lives only inside
`@cloudflare/ai-chat`'s React-only build (`dist/react.js`, a 2-line re-export of
`agents/chat/react`). This spike reverse-engineered the wire format directly from
`agents/dist/chat/index.d.ts`'s exported `parseProtocolMessage()`/`ChatProtocolEvent`/
`CHAT_MESSAGE_TYPES` (the shared, framework-agnostic module both `AIChatAgent` and
`@cloudflare/think` build on — not marked `@internal`) and from
`agents/dist/wire-types-*.js`'s literal message-type strings, then confirmed it live end to end.

**A client sends one WebSocket text frame per chat turn:**

```json
{
  "type": "cf_agent_use_chat_request",
  "id": "<uuid, correlates the response>",
  "init": {
    "method": "POST",
    "body": "{\"messages\":[{\"id\":\"<uuid>\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"...\"}]}],\"trigger\":\"submit-message\"}"
  }
}
```

`messages` is the client's current full message array (server-side `persistMessages`/
`reconcileMessages` reconciles it against `this.messages`); for a fresh turn in an existing chat
this spike sent only the new user message and it was correctly appended to, not replacing, the
persisted history (Section 6 below).

**The server replies with one or more frames per turn, correlated by `id`:**

```json
{ "type": "cf_agent_use_chat_response", "id": "<same uuid>", "body": "<raw chunk text>", "done": false }
...
{ "type": "cf_agent_use_chat_response", "id": "<same uuid>", "body": "", "done": true }
```

**Correction to an implicit assumption**: `body` is **not** classic `data: {...}\n\n` SSE
framing. It is the raw `toUIMessageStreamResponse()` body text forwarded byte-for-byte, and in
practice arrived as bare, newline-free, back-to-back JSON objects (`{"type":"start",...}
{"type":"start-step"}{"type":"text-delta",...}...`) with no `data:`/`event:` prefix at all. A
hand-rolled Vue-side parser (Section 6.2a's composable) must concatenate `body` chunks by `id`
until `done: true` and then extract/parse each `{"type":"..."}` object directly — it must **not**
assume or require an SSE `data:` line format when reading this wire protocol directly (only
`agents/chat`'s own internal replay/recovery code cares about SSE-specific framing for a
different purpose — reconstructing partials from `ResumableStream`'s stored chunks).

Also observed on connect, before any chat frame: a `cf_agent_identity` frame
(`{"type":"cf_agent_identity","agent":"chat-agent","name":"<chat-id>"}`) and a
`cf_agent_mcp_servers` frame (`{"mcp":{"prompts":[],"resources":[],"servers":{},"tools":[]},
"type":"cf_agent_mcp_servers"}`) — `AIChatAgent` unconditionally tracks/broadcasts MCP server
state even when no MCP server is configured, so a hand-rolled client must tolerate and ignore
frame types it does not care about (confirmed both live and by reading `AgentClient`'s own
message listener, which only intercepts `cf_agent_identity`/`cf_agent_state`/
`cf_agent_state_error`/`rpc` and passes everything else through — see Section 7).

## 6. Chat naming/instancing: custom `getAgentByName()` routing confirmed (live-verified)

The Worker's `fetch()` extracts a chat ID from `/chat/<chatId>` and calls
`getAgentByName<Env, ChatAgent, ChatAgentProps>(env.CHAT_AGENT, chatId, { props: { ownerEmail }
})`, then `stub.fetch(request)` — per-**chat** instancing (not per-user), matching Section 6.2's
requirement. The identity frame's `agent` field came back as `chat-agent` — the kebab-cased class
name `ChatAgent` — confirming `routeAgentRequest()`'s documented default URL convention
(`/agents/{kebab-class}/{name}`) uses the same naming transform this spike's custom routing
bypasses, even though this spike never calls `routeAgentRequest()` itself.

**Multi-turn persistence confirmed live across separate WebSocket connections** (not just
separate messages on one socket — a closer match to US-1's "reloading the page and reconnecting
resumes the same conversation" acceptance criterion): a first connection to chat
`probe-multiturn-1` said "remember the secret word: pineapple"; a **second, brand-new** WebSocket
connection to the same chat ID, in a separate process invocation, asked "what was the secret
word?" and the model answered "Pineapple." — proving `this.messages` persistence and reload
survive a fresh connection, not just an in-memory turn queue.

## 7. Cloudflare Access identity threading via `getAgentByName()`'s `props` (source-verified +
   live-verified)

`AgentGetOptions<Env, Props>` (a `Pick` of `PartyServerOptions` including `props`) is accepted by
`getAgentByName()`. Per the installed `partyserver` source, `props` are delivered to the Durable
Object's own `onStart(props)` lifecycle hook and separately carried "over the `x-partykit-props`
header on the underlying `fetch()` request" (a comment directly in `partyserver`'s shipped
`.d.ts`) — never something the client's message body can set. This spike's `ChatAgent.onStart`
captures `props?.ownerEmail` into a private field, which is then interpolated into the system
prompt (never trusted from a client-controlled field).

**Live-verified**: the Worker read a stand-in identity from an `X-Spike-Owner` request header
(never from client-supplied WebSocket frame data) before calling `getAgentByName(..., { props: {
ownerEmail } })`. Asking the model "what email owns this chat?" correctly returned exactly the
header's value (`spike-probe@example.com`), confirming the whole
header → `getAgentByName` props → `onStart` → system prompt path works end to end. The real demo
threads a Cloudflare Access-verified email the same way, reading it from the (Access-validated)
`Cf-Access-Jwt-Assertion` header instead of a spike-only debug header — the mechanism is
identical; only the source of the value changes.

## 8. `AgentClient` (`agents/client`) is genuinely framework-agnostic (source-verified)

`agents/client`'s `AgentClient extends PartySocket extends ReconnectingWebSocket` — no import of
`react` anywhere in that chain (confirmed by reading `agents/dist/client.d.ts` and
`agents/dist/client.js`). Its own internal `message` listener intercepts exactly four frame
types — `cf_agent_identity`, `cf_agent_state`, `cf_agent_state_error`, `rpc` — and passes every
other frame through untouched to any listener the caller adds. This confirms Section 6.2a's plan:
a small Vue composable (`useChatAgent.ts`) can sit directly on `AgentClient` for both `@callable`
RPC/state sync (already handled by `AgentClient` itself) and the chat wire protocol (Section 5,
hand-built on top, exactly the way this spike's probe script does — the probe used the raw `ws`
package only because a plain WebSocket cannot set the custom identity-stand-in header this spike
specifically needed, a constraint that does not apply to `AgentClient` for RPC/state, and does
not apply in the real demo either, since Access sets its identity header at the edge, not the
client).

## 9. `setState()` is a full replacement, not a merge (source-verified)

`Agent.prototype.setState(state: State): void` (not `Partial<State>`) calls
`this._setStateInternal(state, "server")`, whose body is:

```js
_setStateInternal(nextState, source = "server") {
  this.validateStateChange(nextState, source);
  this._state = nextState;                      // <-- full replacement, not Object.assign/merge
  this.sql`INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (${STATE_ROW_ID}, ${JSON.stringify(nextState)})`;
  this._broadcastProtocol(JSON.stringify({ state: nextState, type: "cf_agent_state" }),
    source !== "server" ? [source.id] : []);      // <-- excludes the originating connection only when source is a client
  ...
}
```

Confirms `docs/06-AGENTIC-CHAT.md` Section 6.6a's assumption exactly: `refreshUsageState()` must
always pass the **complete** `{ usage: {...} }` (or a complete merged state object spreading
whatever else `state` holds) — never a partial patch — or it will silently wipe every other field
`state` carries. The broadcast excludes only the connection that itself just called
client-side `setState()` (which already optimistically set its own local `.state` — confirmed
from `AgentClient.setState()`'s own body); a server-initiated `setState()` (source `"server"`,
exactly `refreshUsageState()`'s case) broadcasts to **every** connected client with no exclusion.

## 10. `AIChatAgent` does not occupy the `State` generic for message history
    (source-verified)

`AIChatAgent<Env, State, Props> extends Agent<Env, State, Props>` — message persistence
(`this.messages`, `persistMessages()`, `_loadMessagesFromDb()`) is backed entirely by
`AIChatAgent`'s own dedicated SQLite tables (`cf_ai_chat_agent_*`, referenced throughout
`dist/index.js`), never `this.state`/`setState()`. A demo-defined `State` shape (Section 6.6a's
`{ usage: ChatUsageSummary }`) is therefore free to use the entire `State` generic with no risk of
colliding with or being overwritten by `AIChatAgent`'s own internal bookkeeping.

## 11. `AIChatAgent` in this version is materially more capable than the Agents SDK skill's
    minimal example suggests (source-verified, informational)

The installed `@cloudflare/ai-chat@0.10.1`'s `AIChatAgent` ships a full chat-recovery engine
(interrupted-stream detection and bounded retry/continue across Durable Object eviction/deploy),
built-in resumable-stream replay, agent-tool (sub-agent) orchestration, tool-approval flows, and
row-size/message-count compaction — none of which this repo's `agents-sdk` skill file's
"Basic Chat Agent" example mentions. None of this changed Spike A's minimal chain, but later
phases (especially anything touching `onChatRecovery`, `saveMessages`, or agent tools) should read
the real installed `.d.ts` rather than the skill's simplified example, which is accurate as far as
it goes but omits nearly this entire recovery/tooling surface.

## Follow-ups not covered by this spike

- Whether a `reasoning-field`-mechanism model (`glm-4.7-flash`, `gemma-4-26b-a4b-it`) surfaces a
  distinct `reasoning`/`reasoning-delta` UI part through `workers-ai-provider` (Section 4).
- Live confirmation of resumable streaming actually resuming after a simulated Durable Object
  eviction/hibernation mid-stream (this spike only confirmed persistence across a *closed and
  reopened* connection between turns, not a stream interrupted *during* a turn).
- Live two-connection confirmation of the broadcast-exclusion behavior in Section 9 (confirmed by
  source only, not by opening two sockets and observing one receive a frame the other does not).
