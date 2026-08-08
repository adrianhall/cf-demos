# Decision Log

These decisions, gleaned from building `demos/url-shortener`, have been rolled
into `AGENTS.md` (Resource Ownership, Public Access, Source Organization,
Testing And Verification, and Observability And Security). Keep this log as
the historical rationale; update `AGENTS.md` first when a future demo reveals
the guidance below needs to change again.

## 1. wrangler.local.jsonc vs. wrangler.jsonc.tpl

There were problems with running vite with an alternate wrangler.jsonc, so the decision was made that wrangler.local.jsonc would be abandoned.  The approved way is to fill wrangler.jsonc.tpl from a committed `infra/local-outputs.json`.

`@adrianhall/cloudflare-toolkit`'s `generate-wrangler` CLI grew a `--local`/`-l` mode (v2.2.0) that reads a flat strict-JSON `name -> value` map and substitutes it into `wrangler.jsonc.tpl` with the same marker-scanning and validation logic used for real Terraform outputs. This supersedes the hand-written `scripts/generate-local-wrangler.js` every demo previously carried — `infra/local-outputs.json` is a flat variables map, not a revival of the abandoned `wrangler.local.jsonc` full alternate config, so it does not reintroduce the problem this decision was originally about. Every demo's `generate:wrangler:local` script is now `generate-wrangler -c -l infra/local-outputs.json`.

Since local dev needs a separate environment, the .dev.vars overrides ENVIRONMENT (check this in if there are no secrets in it).  Also, package.json scripts was extensively modified for this new situation and to create the proper workflow.

## 2. vitest projects

We use vitest projects to organize tests.  Don't use playwright.  There is a vitest.config.ts for each type of test - integration in tests/integration, worker in src/worker and client in src/client.  Unit tests sit alongside the source file under test.  Integration tests for the API are separate.

We also added coverage with istanbul to the setup

## 3. Deployment of the worker

Since you can't connect the worker to a domain name until you have a worker deployment, we decided to allow an initial deployment of the worker which will then be overwritten by the wrangler deploy version.

## 4. Source organization

We organize source files for testability.  Do NOT put everything in one file.

## 5. Logging

Just use cloudflareLogger() - don't try to be fancy with log levels or anything like that.

## 6. R2 teardown uses the dashboard empty-bucket API

The R2 dashboard's observed `DELETE /client/v4/accounts/{account_id}/r2/buckets/{bucket_name}/objects?prefix=` request empties a bucket with the ordinary Cloudflare deployment token when it has `Workers R2 Storage - Edit`. The `spikes/empty-r2-bucket` validation confirmed the call deletes every object without S3 credentials or a Terraform-created account token.

`@adrianhall/cloudflare-toolkit` v2.3.0 added an `empty-r2-bucket` CLI that calls this exact same endpoint with the exact same bearer-token auth (confirmed by reading its bundled source), plus a fail-closed non-empty probe and completion polling `demos/media-drop`'s original hand-written `scripts/empty-r2-bucket.js` lacked. Demos now run `empty-r2-bucket -t infra --env-file .env --yes` as their `preteardown:r2` step instead of copying that script; it reads `account_id` and `r2_bucket_name` straight from `terraform output -json`. The endpoint remains undocumented, so this decision must be revisited if Cloudflare publishes, changes, or removes the API.

## 7. depends_on, not `wrangler delete --force`, orders Worker-before-binding teardown

Every `cloudflare_worker` resource now declares `depends_on` pointing at every D1/KV/R2 resource it binds to (see AGENTS.md, Resource Ownership). Terraform destroys in reverse dependency order, so this alone forces the Worker — and its wrangler-managed binding — to be destroyed before the backing resource, which is what actually prevents the "Cloudflare API refuses to delete a bound resource" failure.

The `cloudflare-deploy-scripts` skill's canonical preteardown chain also runs `wrangler delete --force` before `terraform destroy`, as an independent, belt-and-suspenders way to reach the same ordering. This repo deliberately omits it: it has not been validated that the v5 provider tolerates `terraform destroy` encountering a `cloudflare_worker` that Wrangler already deleted out-of-band — a 404 there would require a manual `terraform state rm` to recover, trading one failure mode for another. Revisit this decision (and add `preteardown:worker` back) if a real teardown run shows `depends_on` alone is insufficient, or once the 404-on-destroy behavior has been confirmed safe.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this heading when they have been incorporated.

## 8. Testing hibernatable WebSocket Durable Objects with `@cloudflare/vitest-pool-workers`

Building `demos/chat`'s `ChatRoom` integration tests (docs/04-ENTERPRISE-CHAT.md, Phase 3)
surfaced three distinct problems, each requiring a different fix. Do not treat WebSocket
integration test hangs as something to patch around with longer timeouts — find which of these
(or a new one) actually applies.

**Concurrent integration test files sharing one workerd runtime can starve WebSocket delivery.**
`@cloudflare/vitest-pool-workers` v0.13+ isolates *storage* per test file but can still run
multiple files' Workers concurrently against the pool. Two files each opening hibernatable
WebSockets against the same local runtime intermittently hung indefinitely in this environment,
even though each file passed in isolation. Cloudflare's own Vitest 4 migration guide already
documents the fix for suites that need to share state across files: pass
`--max-workers=1 --no-isolate`, or, in a project's own `vitest.config.ts`, set
`fileParallelism: false`. Set this on any integration project whose test files open real
WebSocket connections, not only ones that need shared storage.

**`ctx.storage.deleteAll()` deletes the schema, not just rows, and the instance may still be
live.** A Durable Object's `destroy()` RPC that calls `ctx.storage.deleteAll()` wipes the SQLite
tables themselves. Unless the instance is also evicted, it keeps running with no schema, and the
next request throws `no such table`. Do not rely on eviction to re-run the constructor and
recreate the schema — the timing is not guaranteed relative to the next request in a test (or in
production, immediately after a client reconnects). Instead, factor schema creation into a
private method the constructor and any storage-erasing RPC both call, so `destroy()` leaves the
object immediately usable again with a freshly initialized, empty store.

**Do not gate test completion on your own outbound WebSocket close handshake.** A test that calls
`clientSocket.close()` and awaits the resulting `"close"` event on that same client socket proved
unreliable in this pool, hanging even after the *server* side had already logged handling the
close. A server-*initiated* close (for example from a Durable Object's own `destroy()` calling
`ws.close(code, reason)`) reliably delivered its close event to the client in testing — only the
client-initiated round-trip was the problem. Do not depend on the client-initiated round-trip for
test correctness or cleanup. Use `evictAllDurableObjects({ webSockets: "close" })` (from
`cloudflare:test`) in `afterEach` as the one unconditional, documented mechanism guaranteeing no
socket outlives a test; call `socket.close()` best-effort without awaiting it.

**Prefer storage inspection over racing a WebSocket message against a timer.** A test asserting
something did *not* happen (routing isolation between two Durable Object instances, a rejected
message never being persisted) is more reliable checking `runInDurableObject`'s storage state
directly than opening a second socket and racing an expected non-event against a `setTimeout`.
The latter pattern is inherently racy and, in this project, correlated with the hangs above.

**Filter WebSocket test assertions by frame `type`, registered before the triggering action, not
by count or arrival order.** A hibernatable WebSocket server that broadcasts a presence update
immediately after replaying history (as `ChatRoom.fetch()` does) means a client's next frame
after "history" is not necessarily the frame under test. Register a `"message"` listener that
resolves only on a specific expected `type` and ignores everything else, always adding the
listener before performing the action expected to trigger that frame. This avoids both assuming
an exact frame count/order and the complexity of a general-purpose event queue.

**Never return a `Response` object across the `runInDurableObject` callback boundary.** A test
covering `ChatRoom.fetch()`'s defensive guard (a direct call missing the Worker-set identity
headers) called `instance.fetch(request)` inside `runInDurableObject` and returned the resulting
`Response` from the callback so the test could assert on it outside. That reliably hung the same
`afterEach` eviction cleanup described above — even though the callback itself completed
synchronously and never touched a real WebSocket — and the hang then cascaded into every
following test in the file, since the stuck eviction call never resolved. Read whatever plain,
structured-clone-friendly fields the assertion actually needs (`response.status`,
`response.webSocket !== null`) inside the callback and return only those; never let a `Response`,
`Request`, or other non-plain object cross that boundary as a return value.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this
heading when they have been incorporated.

## 9. Workers AI local-development findings (`demos/ai-chat`, Phase 1)

Building `demos/ai-chat`'s scaffold (docs/05-AI-CHAT.md, Phase 1) required verifying every claim
in that document's "Workers AI Has No Local Simulation" section against current behavior before
committing to it. All of them held:

- The `ai` binding **must** be declared `{ "binding": "AI", "remote": true }` in
  `wrangler.jsonc.tpl`. Current Cloudflare docs confirm: omitting `remote` on an `ai` binding
  connects remotely anyway and logs a warning; setting `remote: false` on it is a hard error.
  Every other "recommended remote binding" (Browser Run, Vectorize, mTLS, Images) only *warns*
  when `remote` is omitted — Workers AI is the one binding type where the omission is upgraded to
  an error, not just a warning.
- Wrangler picks up `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` from the ordinary `.env` file
  already committed to each demo's root (the same file the `dotenv` Terraform provider reads) with
  no additional export or wrapper script — confirmed by running `npm run build` (no `.env`
  present) and `vite dev` (real `.env` present) from a clean checkout.
- `vite build` does **not** open a remote-binding session even though the `ai` binding is declared
  `remote: true` — confirmed: `npm run build` succeeds with no Cloudflare credentials anywhere in
  the environment. Only a session that actually starts a `workerd` runtime (`vite dev`,
  `vitest`) touches the binding at all.
- `.dev.vars` does what the scenario doc predicted for a second, independent reason beyond the
  local `ENVIRONMENT` value already established for other demos: because it exists, Wrangler stops
  reading `.env` into the Worker's own `env` object, so `CLOUDFLARE_API_TOKEN` never becomes
  readable from `env` inside Worker code even though the same token is used out-of-band to open
  the remote-binding session itself.
- `@cloudflare/vitest-pool-workers`'s `cloudflareTest()` plugin exposes a top-level
  `remoteBindings` boolean option (confirmed by reading the pool's own Zod options schema:
  `remoteBindings: z.boolean().default(true)`), independent of `wrangler`/`miniflare`/`main`. It
  is not documented on the public Configuration page as of this writing, so the schema itself —
  not the docs site — is the source of truth for this option's existence and default. Setting it
  `false` in `tests/integration/vitest.config.ts` was sufficient to run the full test suite
  (`npm test`) on a clean checkout with zero Cloudflare credentials in the environment and no
  network calls to Cloudflare's remote-binding proxy — verified by running the suite with no
  `.env` file present at all.
- Integration tests drive the Worker via `worker.fetch(request, env, ctx)` (importing the Hono app
  directly, with `createExecutionContext()`/`waitOnExecutionContext()` from `cloudflare:test`)
  rather than `SELF.fetch()`, established starting in Phase 1/2 even before any route calls
  `env.AI.run()`, specifically so a later phase can substitute `{ ...env, AI: fakeAi }` at the
  exact same call site without restructuring the test fixtures.

Demos 6 and 7 (AI Gateway, voice) inherit an `AI` or equivalent remote-only binding and should
reuse this section's findings rather than rediscovering them.

## 10. Workers AI streaming chunk shapes do not follow the declared input type (`demos/ai-chat`, Phase 3)

docs/05-AI-CHAT.md's Phase 3, step 9 mandates a throwaway spike against the deployed account
before writing the model catalog or adapters, specifically because the model catalog page and the
generated types describe *input* shapes, not *streaming output* shapes. The spike (`curl -N` against
`POST /client/v4/accounts/{account}/ai/run/{model}` with `stream: true`, one call per catalog
model) found real behavior materially different from the scenario doc's original draft in three
ways. All three are now corrected directly in docs/05-AI-CHAT.md's Model Catalog and Model
Adapters sections; this entry is the supporting evidence trail, not a duplicate of the correction.

**Streaming chunk shape is not determined by the model's declared input type.** Of the three
models sharing the permissive `AiTextGenerationInput`/`BaseAiTextGeneration` input type (Granite,
Scout, DeepSeek R1 Distill), only DeepSeek actually streams the "raw cf-native" `{ response,
usage }` chunk shape the type's family name suggests. Granite and Scout both stream the *other*
adapter's shape instead — `{ choices: [{ delta: { content }, finish_reason }], usage }` — despite
accepting `max_tokens`/no `stream_options` on the way in. Scout additionally mirrors the same text
into a redundant top-level `response` field per chunk; Granite does not. Do not assume "shares an
input type" implies "shares an output shape" for any future catalog addition — spike the actual
stream before writing its `readChunk()`.

**Per-model temperature bounds can be tighter than the shared input type's declared range.**
Granite and DeepSeek both accept `temperature` up to `5` (confirmed: `5` succeeds, `5.5` is
rejected). Scout — despite sharing Granite/DeepSeek's input type — rejects anything above `2` with
a `400` (`temperature must be in [0, 2], got 3.5`) directly from Workers AI, not from this Worker's
own validation. This is why `src/worker/chat/validation.ts` clamps to the **descriptor's** bounds,
never an adapter-wide constant: two models sharing one adapter can disagree on range.

**Per-chunk `usage` is not cumulative; only the final chunk before `[DONE]` carries the true
total, and this holds for every model regardless of adapter.** Every per-token delta chunk carries
its own small `usage` object (typically `completion_tokens: 1`, describing just that one delta).
Immediately before the `[DONE]` sentinel, every model — including DeepSeek, which has no `choices`
key anywhere else in its stream — emits one identically-shaped terminal chunk, `{ response: "",
usage: { prompt_tokens, completion_tokens, total_tokens } }`, carrying the cumulative total for the
whole turn. The correct extraction rule proven by the spike is "keep overwriting a single tracked
`usage` value with whatever the most recent chunk reported, and use whatever is left when the
stream ends" — not summing deltas, and not gating extraction on the presence or absence of a
`choices` key (which would incorrectly exclude DeepSeek, whose *only* chunk shape lacks `choices`).
`stream_options: { include_usage: true }` is still sent on the `openai-chat` adapter's input as the
documented, forward-compatible way to request usage, but the spike observed the terminal usage
frame appear even without it — do not treat its absence elsewhere as proof usage will come back
`null` without re-verifying per account/gateway version.

Demos 6 and 7 build directly on the adapter registry this spike shaped; reuse `readChunk()`'s
choices-shape-first-then-response-fallback pattern and the "last usage chunk wins" extraction rule
rather than rediscovering either.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this
heading when they have been incorporated.

## 11. `AIChatAgent` + Workers AI + AI Gateway end-to-end findings (`spikes/00-aichatagent-basics`,
    docs/06-AGENTIC-CHAT.md Spike A)

Full report: `spikes/00-aichatagent-basics/REPORT.md`. Access mechanism used: option 1 (a
minimal, spike-scoped Terraform config reusing the `dotenv` provider and AGENTS.md's bypass-policy
shape verbatim) — worked without friction; nothing about a `*.workers.dev` domain (vs. a custom
domain) needed special handling in the Access application resource itself.

**This account's Zero Trust posture blocks `wrangler dev`'s remote-binding proxy for `env.AI`, not
only inbound HTTPS to a deployed Worker.** docs/06-AGENTIC-CHAT.md's Section 8 originally assumed a
spike using only a remote binding (no deployed public endpoint) needs neither Terraform nor Access,
mirroring demo 5's "Workers AI Has No Local Simulation" finding. On this account, `wrangler dev`'s
own "Establishing remote connection…" step for `env.AI` never completed — the remote-binding proxy
itself apparently depends on an account-level Cloudflare endpoint this account's posture gates
behind Access, so a purely local session has no way to authenticate through it. The workaround was
to deploy for real and drive the Worker over its own bypass-fronted public hostname instead (Section
8's second bullet). Future spikes (and local development for the demo itself, if this holds beyond
`wrangler dev`) needing a live `env.AI` call should expect to need a real deployment on this account
specifically — this may be an account-level SASE/Gateway policy peculiarity rather than a general
Cloudflare platform fact, so re-verify on a different account before generalizing further.

**An AI Gateway `gateway: { id }` must reference an already-provisioned gateway; only the literal id
`"default"` auto-provisions.** Cloudflare's own docs ("AI Gateway automatically creates a default
gateway on the first authenticated request") read as if any id would auto-provision on first use.
Passing an arbitrary custom id through `workers-ai-provider`'s `gateway: { id }` option that had
never been created failed with `AI_APICallError: 2001: Please configure AI Gateway in the
Cloudflare dashboard` until the gateway was created via `POST
/accounts/{account}/ai-gateway/gateways` first. Any demo or spike relying on a named (non-`default`)
AI Gateway must provision it as real infrastructure before first use — do not assume auto-creation
for anything but the literal id `"default"`.

**`workers-ai-provider` normalizes streaming *transport* shape to the AI SDK's UI-message-stream
protocol uniformly across models, but does not lift an inline-`<think>`-tag reasoning model's
reasoning into a distinct message part.** Driving both a non-reasoning model
(`@cf/ibm-granite/granite-4.0-h-micro`) and demo 5's `inline-think-tags` reasoning model
(`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, docs/DECISIONS.md #10) through the identical
`streamText()` call produced the identical, clean event sequence (`start → start-step → text-start →
text-delta × N → text-end → finish-step → finish`) for both — confirming the provider absorbs the
raw-Workers-AI-native shape divergence #10 found when calling `env.AI.run()` directly. However, the
DeepSeek model's `<think>...</think>` block still arrived as ordinary `text-delta` content, exactly
as it does at the raw Workers AI layer — there is no distinct `reasoning`/`reasoning-delta` UI part
for this model through this provider. Any demo wanting a "Thinking" panel for an
`inline-think-tags`-mechanism model must still split it out itself (reuse
`demos/ai-chat/src/worker/chat/reasoning.ts`'s approach); `workers-ai-provider` is not a substitute
for it. Untested: whether a `reasoning-field`-mechanism model (`glm-4.7-flash`, `gemma-4-26b-a4b-it`)
fares differently through this provider.

**`AIChatAgent`'s WebSocket wire protocol is undocumented outside its React-only client build, and
its streaming-response `body` is not classic SSE framing.** No framework-agnostic helper for
constructing an `AIChatAgent` chat turn is exported — `@cloudflare/ai-chat/react`'s `useAgentChat`
is the only shipped client, and it is React-only (re-exporting `agents/chat/react`, unusable in a
Vue app per AGENTS.md). The protocol itself was reverse-engineered from `agents/dist/chat/index.d.ts`'s
exported (not `@internal`) `parseProtocolMessage()`/`ChatProtocolEvent`/`CHAT_MESSAGE_TYPES` and
confirmed live: a client sends one `{"type":"cf_agent_use_chat_request","id":"<uuid>",
"init":{"method":"POST","body":"<json>"}}` frame per turn; the server replies with one or more
`{"type":"cf_agent_use_chat_response","id":"<same uuid>","body":"<chunk>","done":boolean}` frames.
Critically, `body` is **not** `data: {...}` SSE framing — it is the raw `toUIMessageStreamResponse()`
body text forwarded byte-for-byte, which in practice arrives as bare, back-to-back JSON objects with
no `data:`/`event:` prefix at all. Any hand-rolled client (this demo's planned
`useChatAgent.ts` Vue composable, per docs/06-AGENTIC-CHAT.md Section 6.2a) must concatenate `body`
chunks by `id` until `done: true` and parse the resulting text as bare JSON objects, not as SSE.
`AgentClient` itself (`agents/client`) remains genuinely framework-agnostic (extends `PartySocket`
extends `ReconnectingWebSocket`, no React anywhere in that chain) and is the right transport to
build this on — its own message handling only intercepts `cf_agent_identity`/`cf_agent_state`/
`cf_agent_state_error`/`rpc` frames and passes the chat frames above through untouched.

**`setState()` is a full state replacement, not a merge; `AIChatAgent` never occupies the `State`
generic.** Confirmed by reading the installed `agents` package: `Agent.prototype.setState(state:
State)` (not `Partial<State>`) does `this._state = nextState` — full replacement — and broadcasts to
every other connected client (the originating client, if the call came from a client `setState()`,
is excluded — it already applied its own value optimistically). Any demo composing a `State` shape
from multiple independently-updated pieces (docs/06-AGENTIC-CHAT.md Section 6.6a's
`refreshUsageState()`) must always write the complete object. Separately, `AIChatAgent` backs
`this.messages` entirely with its own dedicated SQLite tables, never `this.state`/`setState()`, so a
demo-defined `State` shape can safely use the whole generic.

**Installing `@cloudflare/ai-chat` pulls in `react`/`@ai-sdk/react` even for server-only use, but
this is inert.** `@cloudflare/ai-chat`'s `package.json` lists `react`/`@ai-sdk/react` as required
(non-optional) peer dependencies, unlike `agents`, which marks its own React-adjacent peers optional.
`npm install` auto-installs them even when only the main (non-React) entry is ever imported. Reading
the compiled bundle confirms the main entry's code never imports React — only the separate
`/react` subpath does — so this costs `node_modules` weight only, never a deployed bundle or runtime
concern, as long as `@cloudflare/ai-chat/react`/`agents/react`/`agents/chat/react` are never
imported.

## 12. Dynamic Workers `globalOutbound` egress-control findings (`spikes/02-dynamic-workers-egress-control`,
    docs/06-AGENTIC-CHAT.md Spike C)

Full report: `spikes/02-dynamic-workers-egress-control/REPORT.md`. Unlike Spike A, this spike
needed **no deployment, no Terraform, no Cloudflare Access application at all** — everything below
was confirmed live entirely via `wrangler dev`/`@cloudflare/vitest-pool-workers`.

**`worker_loaders` is not a proxy to an external account resource, so it has no `remote` mode and
needs no deployment to test for real.** Unlike `env.AI` (Spike A, decision #11) or D1/KV/R2 remote
bindings, Wrangler's config schema has no `remote: true`/`false` option for `worker_loaders` at
all — it is a pure `workerd` runtime primitive. `wrangler dev`'s default local mode runs the real
`workerd` binary, so a Dynamic Worker loaded, executed, and network-gated through `globalOutbound`
locally is not a separate "simulation" the way KV/D1's local storage or `env.AI`'s remote proxy
are — it is the same code path production runs. This means a spike (or later, this demo's own
local development) exercising Dynamic Workers does not need Spike A's "deploy for real and front
it with a bypass Access application" workaround; Section 8's original "no inbound HTTPS endpoint →
no Terraform, no Access" framing holds for this binding specifically.

**The Workers Paid plan prerequisite was confirmed for this account without deploying.** `GET
/accounts/{account_id}` (the same account-scoped API token every demo's Terraform already reads
from `.env`) reports this account's `"type"` as `"enterprise"` — strictly above the Workers Paid
tier Dynamic Workers require — corroborated by direct operator confirmation of prior successful
Dynamic Workers use on this account. Any future demo/spike needing to confirm this prerequisite on
a different account can reuse this same unauthenticated-by-billing-tier `GET /accounts/{id}` call
rather than assuming a deployment is required to find out.

**A Durable Object calls `env.LOADER.get()`/`.load()` exactly like a top-level `fetch()`
handler — no special-casing.** `this.env.LOADER.get(id, callback)` inside a Durable Object method
worked identically to the top-level-`fetch()`-handler shape Cloudflare's own docs show, confirmed
live by a real network fetch to `https://example.com/` returning its actual page body through the
whole chain (Worker `fetch()` → Durable Object → `env.LOADER.get()` → Dynamic Worker →
`globalOutbound` gateway → real network).

**`ctx.exports` is directly reachable from inside a Durable Object method, with no threading
required — a genuine surprise `DurableObjectState`'s documented API surface gives no hint of.**
`DurableObjectState`'s documented properties (`ctx.storage`/`ctx.id`/`ctx.waitUntil`/
`ctx.blockConcurrencyWhile`/...) do not list `exports` anywhere. Probing it directly inside a
Durable Object method (`(this.ctx as unknown as { exports?: unknown }).exports`) returned a real,
usable object, live-verified. A future phase may call `this.ctx.exports.SomeGateway({})` straight
from a Durable Object if there is ever a reason to skip threading a `ctx.exports`-derived stub in
as an RPC parameter from the Worker's own `fetch()` call site — this spike's own code still threads
it in regardless, for the per-request props-scoping reasons `REPORT.md` §5 explains, not because
the direct path is broken.

**`ctx.exports.<Name>()` requires its options argument — Cloudflare's own egress-control doc
example (`ctx.exports.HttpGateway()`) is a TypeScript error against the generated type.**
`wrangler types`' generated `LoopbackServiceStub<T>` type is `Fetcher<T> & (opts: { props?: Props
}) => Fetcher<T>` — the call signature's `opts` parameter has no default and is not optional, only
its own nested `props` field is. Compiling the docs' own bare `()` form fails with `TS2554:
Expected 1 arguments, but got 0`; the correct call is `ctx.exports.EgressGateway({})` when no
`props` are needed. Any future TypeScript demo code following Cloudflare's JS-only doc examples
for `ctx.exports` should expect this.

**Storing a bare reference to the global `fetch` function on a plain object and calling it later
throws `Illegal invocation` inside `workerd` — wrap it in a closure instead.** To make an
`EgressGateway` unit-testable by injecting a fake `fetch` (see below), this spike first tried
`export const networkFetch = { impl: fetch }` and later called `networkFetch.impl(request)`. This
threw live: `Illegal invocation: function called with incorrect \`this\` reference` — workerd's
native `fetch` requires the global scope as its receiver, and extracting it as a bare value onto
another object's field loses that implicit receiver (see
`developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors`). The fix is
wrapping it in an arrow function, `{ impl: (request) => fetch(request) }`, so the call site inside
the arrow function's own body still invokes `fetch` with the correct implicit receiver. Any future
Worker code that stores a reference to the global `fetch` (or any other native, receiver-sensitive
API) on a plain object or class field for dependency-injection purposes should wrap it in a closure
rather than assigning the bare function reference.

**A blocked `globalOutbound` gateway surfaces to the sandboxed Dynamic Worker's own code as a
thrown exception from `fetch()`, not merely a non-2xx `Response`.** A tool running inside a Dynamic
Worker whose `globalOutbound` blocks a request must wrap its own `fetch()` call in a `try`/`catch`
or an agent-side tool call crashes instead of producing a model-visible refusal explanation (US-9's
acceptance criterion). This spike's `getUrl`-tool stand-in code does this and turns the caught
exception into an ordinary `502` `Response` carrying the gateway's refusal message.

**Both of Spike C's stated testability questions are confirmed yes, live.** The `EgressGateway` is
unit-testable with zero real network traffic by mutating the closure-wrapped `networkFetch.impl`
seam above in a test (an ES module's imported `const` binding cannot be *reassigned* from another
module, but the object it points to can be *mutated* in place — `networkFetch.impl = fakeFetch`).
`@cloudflare/vitest-pool-workers` fully supports `worker_loaders`, exercised end to end
(`ctx.exports` → Durable Object → `env.LOADER` → Dynamic Worker → gateway) via `import { exports }
from "cloudflare:workers"; await exports.default.fetch(new Request(...))` — the same pattern
`demos/chat/tests/integration/worker.test.ts` already uses — deliberately against a
non-allow-listed host so no real network call happens inside the automated test run. Getting this
running required two setup details easy to miss in a fresh scaffold: `tsconfig.json`'s
`compilerOptions.types` must include `"@cloudflare/vitest-pool-workers/types"` (alongside `"node"`)
for `cloudflare:test`/`cloudflare:workers` test-only imports to resolve at all, and manually
constructing a `WorkerEntrypoint` subclass in a unit test must pass the real `env` object imported
from `cloudflare:test`, not a bare `{}` — `wrangler types`' generated `Env` interface includes
every declared binding, so an empty object literal fails `tsc --noEmit`'s structural check against
it.

## 13. AI Gateway dynamic routing as Terraform infrastructure (`spikes/01-ai-gateway-dynamic-routing`,
    docs/06-AGENTIC-CHAT.md Spike B)

Full report: `spikes/01-ai-gateway-dynamic-routing/REPORT.md`. Access mechanism used: option 1 (a
minimal, spike-scoped Terraform config reusing the `dotenv` provider and AGENTS.md's bypass-policy
shape, matching Spike A) — needed here specifically because `env.AI.aiGatewayLogId`/
`env.AI.gateway(id).getLog()` are Workers Runtime binding features with no plain-HTTP equivalent,
so observing them requires a real deployed Worker, not just `wrangler dev` against a remote
binding.

**The pinned `cloudflare/cloudflare ~> 5.22.0` provider fully supports AI Gateway dynamic
routing** — `cloudflare_ai_gateway` (the gateway, including `spend_limits` rules) and
`cloudflare_ai_gateway_dynamic_routing` (one resource per route, with the same
`start`/`conditional`/`percentage`/`rate`/`model`/`end` element graph the dashboard's own route
builder uses) are both present in the schema, confirmed by dumping `terraform providers schema
-json` directly (the public Terraform Registry page renders client-side and could not be scraped).
No hand-written provisioning script is needed for any of it — but three non-obvious gotchas must
be worked around, all now baked into `spikes/01-ai-gateway-dynamic-routing/infra/main.tf` and
`docs/06-AGENTIC-CHAT.md`'s Phase 1 Scaffolding step for later demos to copy verbatim:

- **A model node's `provider` property is renamed `ai_gateway_dynamic_routing_provider` in this
  Terraform resource's HCL**, diverging from the raw JSON API's own `properties.provider` key
  (confirmed by reading back this account's pre-existing `demo-gateway`/`actor-model-routing`
  route). Using the plain `provider` name is silently dropped by `terraform plan` (no diff, no
  error) and only surfaces as a `400 { "message": "Required", "path": [..., "properties",
  "provider"] }` at `apply` time, since the real key was never sent.
- **A conditional node's `conditions` property is a plain Terraform `string` attribute, not a
  nested object** — the actual JSON API shape (reverse-engineered from the same pre-existing
  route, since it appears nowhere in the public docs or the generated `cloudflare-typescript` SDK
  types) is a small Mongo-style query object keyed by dotted metadata path,
  `{"metadata.<key>": {"$eq": "<value>"}}`. HCL must `jsonencode()` this object into the string
  attribute. Live-verified this exact syntax actually steers the resolved model by request
  metadata, not just that `apply` accepts it: `{"metadata.business": {"$eq": "leadership"}}`
  correctly routed `leadership` calls to one model and every other value to another, cross-checked
  against the gateway's own logs list. A "rate" node on the same route (`limit`/`window`/
  `limit_type` properties) was also live-verified to gate a branch: the first N calls within the
  window reached the intended model, the next calls automatically fell back, no application code
  involved.
- **`cloudflare_ai_gateway_dynamic_routing` is not plan-stable after the first `apply`.** The
  API's `GET .../routes/{id}` response nests the route's element graph one level down, under
  `version.data` — never at a top-level `elements` field — and this provider version's `Read`
  does not map it back onto the `elements` attribute. Every subsequent `terraform plan`, even with
  zero config changes, therefore reads `elements` back empty and proposes destroying and
  recreating the whole route. Fix: `lifecycle { ignore_changes = [elements] }` on the resource,
  the same category of narrow, explicit, documented provider-limitation workaround as the
  bootstrap-deployment exception. Consequence for later phases: this means a deliberate
  `terraform apply -replace=<route resource>` is required to actually change a route's shape after
  creation — a plain `apply` will never pick the change up.
- **`cloudflare_ai_gateway`'s `log_management`/`log_management_strategy`/`zdr`/`logpush` fields
  must be pinned explicitly in HCL** (to the values the API itself would otherwise default to) —
  left unset, the API silently fills them in server-side, Terraform reads those values back on the
  next `plan`, and — since the config still says nothing — proposes removing them, forever.

**Creating a route (`POST .../routes`, what Terraform's `create()` does) auto-versions and
auto-deploys/activates it in the same call** — confirmed via a raw scratch API call before
touching Terraform. There is no separate deployment resource or step needed; a route is live and
callable immediately after `apply` completes.

**Calling a route works identically via `env.AI.run("dynamic/<name>", ..., { gateway: { id,
metadata } })` (the Workers binding) and via the plain REST `/ai/v1/chat/completions`/`/ai/run`
endpoints (header `cf-aig-gateway-id`)** — both were live-verified end to end, including the
conditional and rate-limit routing behavior above.

**`env.AI.aiGatewayLogId` is confirmed `null` for every call whose model argument is a dynamic
route name, even though it is correctly populated for a literal model ID through the exact same
gateway.** Reproduced across a dozen-plus real calls, both routes, with and without metadata,
successful and failed. This is a load-bearing correction to `docs/06-AGENTIC-CHAT.md` Section
6.6's original cost-reconciliation design, which assumed `aiGatewayLogId` would always be
available to schedule a `getLog()` reconciliation from — but every real turn from Phase 4 onward
calls a dynamic route, not a literal model ID. AI Gateway's own logs-list API (`GET
/accounts/{account}/ai-gateway/gateways/{id}/logs`) does still record a full, correctly-costed
entry for the resolved underlying model of a successful dynamic-route call (and a separate,
`cost: 0`/`provider: "unknown"` entry for `model: "dynamic/<route-name>"` itself, but only when
every branch fails to resolve) — so a correlation-by-query fallback is plausible — but neither the
`cf-aig-event-id` request header/`gateway.eventId` binding option nor the logs endpoint's own
`event_id` query filter behaved as documented in this sweep (the header's value never appeared on
the resulting log row; the query filter did not filter the returned page at all). Demo 6's Spike
F, which explicitly depends on this spike's findings, must resolve a working log-correlation
mechanism for a dynamic-route call before Phase 6's reconciliation design can be implemented as
originally written. Any future demo reading a completed turn's cost back from AI Gateway when the
model was chosen via a dynamic route should start from this open question, not assume
`aiGatewayLogId` works.

**`AiGatewayLog`'s real field names are `tokens_in`/`tokens_out` and a plain-number `cost`, not
`prompt_tokens`/`completion_tokens`** (confirmed identically via both `env.AI.gateway(id).getLog()`
and the raw REST logs API) — `usage_metadata.input_tokens`/`usage_metadata.output_tokens` is a
second, differently-named duplicate of the same two figures. `getLog()`'s "not yet available"
signal is a **thrown** `AiGatewayLogNotFound: Log not found` error, not a `404`-shaped return
value, a `null` field, or any other non-throwing signal — confirmed live by calling it with a
made-up id.

**Not every Workers AI catalog model works when invoked through a dynamic route's `model` node —
this must be spiked per model against a real route, independent of whether the same model works
called directly.** A sweep of eight models against disposable scratch routes on this account's
own pre-existing `demo-gateway` found `@cf/ibm-granite/granite-4.0-h-micro` (demo 5's and Spike
A's own verified non-reasoning pick), `@cf/meta/llama-3.1-8b-instruct`,
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/meta/llama-4-scout-17b-16e-instruct`,
`@cf/openai/gpt-oss-120b`, `@cf/zai-org/glm-4.7-flash`,
`@cf/mistralai/mistral-small-3.1-24b-instruct`, and `@cf/meta/llama-3.2-3b-instruct` **all fail**
every routed call with `AiGatewayError 2002: Failed to parse model output` (or, for two of them,
`7003: Model execution failed (Error)`), despite working fine called directly elsewhere in this
repo. Only `@cf/zai-org/glm-5.2`, `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`,
`@cf/qwen/qwen2.5-coder-32b-instruct`, and `@cf/google/gemma-4-26b-a4b-it` were confirmed working
in this sweep. This does not correlate cleanly with `docs/05-AI-CHAT.md`'s declared adapter family
(`openai-chat` vs. `cf-native`) — `glm-4.7-flash` and `gemma-4-26b-a4b-it` share that family and
gave opposite results — extending decision #10's "shares an input type does not imply shares an
output shape" warning to a third layer (the dynamic route's own model-node response adapter, on
top of a model's raw streaming shape and its non-streaming chat-completions adapter). A future
demo choosing a dynamic-route model catalog must re-verify it against a real route rather than
reusing a prior demo's direct-call catalog.

## 14. Workers AI speech-to-text input contract and a `workers-ai-provider`/platform contradiction
    for nova-3 (`spikes/05-workers-ai-speech-to-text`, docs/06-AGENTIC-CHAT.md Spike E)

Full report: `spikes/05-workers-ai-speech-to-text/REPORT.md`. Access mechanism used: option 1 (a
minimal, spike-scoped Terraform config reusing the `dotenv` provider and AGENTS.md's bypass-policy
shape, matching Spike A) — needed because this spike calls `env.AI.run()` for real transcription,
and per decision #11, `env.AI` needs a real deployment on this account rather than `wrangler dev`'s
remote-binding proxy.

**`@cf/openai/whisper-large-v3-turbo` accepts a browser `MediaRecorder`'s raw
`audio/webm;codecs=opus` output directly, with no client-side conversion — the same base64-string
`env.AI.run()` call works identically for both a `MediaRecorder`-shaped WebM/Opus fixture and a
client-side-converted WAV file.** Both fixtures (the same underlying ~12-second utterance) returned
byte-for-byte-equivalent transcriptions and, tellingly, an **identical** decoded
`transcription_info.duration` — proving the model decodes the Opus-in-WebM container correctly
rather than misreading or truncating it. Any future demo needing browser-captured speech-to-text
should post the `MediaRecorder` Blob straight through; there is no reason to add a client-side
transcoding step (ffmpeg-WASM or otherwise) for this model.

**`@cf/deepgram/nova-3` is not currently usable for transcription via the `env.AI` Workers binding
on this account — `workers-ai-provider@4.0.0`'s own shipped implementation for this model is
live-rejected by the platform.** The provider's `runNova3()` sends `{ audio: { body:
base64String, contentType } }` for the binding path; this exact shape, live-verified through three
independent call routes (this spike's own direct binding call, the same call with `body` as a raw
non-base64 `Uint8Array`, and `workers-ai-provider`'s own `experimental_transcribe()`), fails every
time with `5006: Error: required properties at '/audio' are 'body,contentType'`. A direct REST API
call with the identical JSON body reproduces the same error, ruling out an account/gateway-specific
cause. The only shape that actually works for nova-3 is the REST endpoint's raw-binary-body upload
(`Content-Type: audio/wav`, the audio's real bytes as the HTTP body, no JSON wrapper) — a
fundamentally different upload mechanism the `env.AI` binding (JSON-serializable inputs only)
cannot reach at all. Any future demo evaluating nova-3 via the Workers binding should expect this
failure and either use `whisper-large-v3-turbo` instead or call nova-3 through a REST fetch with a
raw binary body (accepting the loss of AI Gateway request/response binding integration that
implies) — and this is worth reporting upstream to Cloudflare/`workers-ai-provider`, since the
provider's own compiled code does not work against its own platform's current schema validation
for this one model.

**`ai@7.0.48`'s `experimental_transcribe()`/`transcribe()` has no `mediaType` parameter at all**,
contradicting a Cloudflare `workers-ai-provider` changelog example
(`developers.cloudflare.com/changelog/post/2026-02-13-glm-4.7-flash-workers-ai/`) that shows
`experimental_transcribe({ ..., mediaType: "audio/wav" })`. Reading `node_modules/ai/dist/index.js`
confirms the SDK now derives media type itself via magic-byte sniffing over the raw audio bytes
(`@ai-sdk/provider-utils`' `detectMediaType()`, whose signature table includes `audio/webm` keyed
on the EBML magic bytes `[0x1A, 0x45, 0xDF, 0xA3]`) — never from the caller's HTTP `Content-Type`
header. Passing `mediaType` to `experimental_transcribe()` against this pinned `ai` version fails
`tsc --noEmit` immediately (a real type error, not a silently-ignored option), so this is a
low-severity but real doc/SDK-version-drift trap: any future demo following that changelog example
verbatim against a current `ai` install will not compile.

**`experimental_transcribe()`'s normalized output silently drops Whisper's per-word timestamps.**
The raw `env.AI.run()` response's `segments[].words[]` array (used for word-level highlighting) is
present in the raw binding response but absent from `workers-ai-provider`'s normalized
`TranscriptionResult` — confirmed by reading `normalizeWhisperResponse()`, which maps only
`{ text, startSecond, endSecond }` per segment for turbo (the per-segment `words[]` fallback exists
only for classic `@cf/openai/whisper`'s flatter output shape). A future phase wanting word-level
highlighting must call `env.AI.run()` directly rather than `experimental_transcribe()`.

**The older `@cf/openai/whisper` model also tolerates a WebM/Opus container fed as a raw byte
array** (`{ audio: Array.from(bytes) }`, Cloudflare's own documented shape for this model), not
only genuinely raw PCM/WAV — but its transcription quality is measurably worse (incorrect brand
capitalization, dropped punctuation) and its model-call latency measurably higher than the turbo
model's, for the same audio, in this spike's repeated live comparisons. Combined with nova-3's
binding failure above, this leaves `whisper-large-v3-turbo` as the clear, doubly-confirmed choice
for this demo's dictation feature.

## 15. The released Agent Skills mechanism composes with `AIChatAgent` directly — once a real
    `SkillRegistry` load-ordering bug is avoided (`spikes/03-agent-skills-composability`,
    docs/06-AGENTIC-CHAT.md Spike D)

Full report: `spikes/03-agent-skills-composability/REPORT.md`. Access mechanism used: option 1 (a
minimal, spike-scoped Terraform config reusing the `dotenv` provider and AGENTS.md's bypass-policy
shape, matching Spike A) — needed for the same reason as Spike A: a live, tool-calling `env.AI`
turn cannot be exercised through `wrangler dev`'s remote-binding proxy on this account
(decision #11).

**The released Agent Skills mechanism lives in the `agents` package's own `agents/skills` subpath
export, not `@cloudflare/think`, and is unrelated to the `agents:skills` Vite-plugin virtual
module of the same-looking name.** `docs/06-AGENTIC-CHAT.md`'s own prior framing (and this spike's
original aim) assumed the mechanism was `@cloudflare/think`-specific, reachable via an
`agents:skills` import. Source-verified: `agents:skills` is a **build-time-only** virtual module
(`agents/skills-module.d.ts`'s own doc comment: resolved by the Agents *Vite plugin* for a
*bundled* skill directory) — a different, narrower thing from the actual runtime mechanism, which
is `agents/skills`'s exported `SkillRegistry` class plus source factories (`r2()`, `fromManifest()`,
`runner()`). `@cloudflare/think` merely also imports this subpath internally; it has no dependency
on `Think` at all. Any future demo wanting R2-backed, runtime-discovered skills (not skills bundled
at build time) should import `agents/skills` directly, never `agents:skills`.

**`SkillRegistry.tools()` reads its descriptor map synchronously and does not itself await
`.load()` — calling it concurrently with `registry.systemPrompt()` silently returns an empty tool
set, with no error or warning.** This is a real bug this spike hit, not a hypothetical: writing the
natural-looking `const [catalogPrompt, skillTools] = await Promise.all([registry.systemPrompt(),
registry.tools()])` evaluates `registry.tools()` **synchronously at call time**, before either
promise in the array is awaited — so it always runs before `.systemPrompt()`'s internal `.load()`
(a real, awaited R2 `list()`/`get()` round trip) has populated the registry's descriptor map,
deterministically, every time, not flakily. The result: `.tools()` returns `{}` (source-verified:
`tools.activate_skill = tool(...)` is only assigned `if (modelSkillNames.length > 0)`), while
`.systemPrompt()` still correctly describes the skill and instructs the model to "use
activate_skill" — so the model, given an instruction to use a tool that does not actually exist,
narrates the tool call as plain text instead of invoking it (`"activate_skill
cloudflare-spike-fact"` verbatim, with no structured `tool-call` stream part at all). **The fix is
sequential, not concurrent, resolution**: `const catalogPrompt = await registry.systemPrompt();
const skillTools = registry.tools();` — awaiting the catalog to completion first, then calling
`.tools()` afterward. With that fix, the plain, single-`streamText()`-call design (`system:
[persona, catalogPrompt].join(...)`, `tools: skillTools`, no forced `toolChoice`) worked correctly
on the first live try: a skill-matching question correctly chained `activate_skill` →
`read_skill_resource` → a final answer containing a real R2-stored fixture value the model had no
other way to know, and an unrelated question correctly triggered no tool call at all. Any future
Worker code combining an async "describe what's available" call with a synchronous "get the actual
callable thing" call on the same lazily-loaded object should suspect this same ordering trap if the
synchronous call appears to return successfully but as if nothing were registered.

**This bug's symptom (narrated-text-instead-of-a-tool-call) is easy to misdiagnose as a model or
streaming-provider reliability problem, because `workers-ai-provider` has a real, separate
mechanism for a superficially identical symptom.** Before finding the actual cause above, this
spike spent real effort suspecting `workers-ai-provider`'s streaming tool-call handling itself,
because its own source comments name a "gpt-oss harmony quirk" where a *forced* tool call can
stream as buffered text instead of structured tool-call parts, recovered by a `salvageToolCallsFromText`
function gated on `isForcedToolChoice` (`toolChoice: "required"` or a named-tool form) — never on
the default, unforced `"auto"` choice a conditionally-activated tool like `activate_skill` needs.
This salvage mechanism is real and confirmed live (a hand-rolled tool forced via `toolChoice: {
type: "tool", toolName: ... }` streamed correctly across three consecutive forced steps), and is
worth knowing for any future design that must force a tool choice on a Workers AI model for a
different reason — but it was not the cause of this spike's failure, which reproduced identically
across streaming and non-streaming calls, forced and unforced, and three different models, right up
until the `Promise.all` race above was fixed. A future spike or phase hitting "the model narrates
my tool call as text instead of calling it" should check for this ordering trap (if a `SkillRegistry`
or similarly lazily-loaded tool source is involved) before assuming it needs `workers-ai-provider`'s
forced-choice salvage path.

**`agents/skills` unconditionally imports `@cloudflare/codemode` and `just-bash` at module top
level, even when only `activate_skill`/`read_skill_resource` are used**, adding a measured +58% raw
/ +71% gzip to the deployed bundle size versus an otherwise-identical Worker with no skills (2840.87
KiB / 533.70 KiB gzip without, 4479.79 KiB / 912.45 KiB gzip with) — both packages are used only by
the `worker_loaders`-backed `runner()` factory (`run_skill_script`), never called by this spike, but
imported regardless (source-verified: `agents/dist/skills/index.js`'s own top-of-file imports).
Both totals stay well under either Workers plan's compressed-size ceiling, so this is not a
deployability blocker, but any future demo adopting `agents/skills` for only its catalog/activation
tools (not script execution) pays this cost with nothing to show for it — worth factoring into a
bundle-size budget if a demo is already close to a plan ceiling for other reasons.

## 16. AI Gateway cost/log reconciliation for a dynamic-route call — a per-turn correlation UUID
    against the logs-list REST API, not `aiGatewayLogId`/`getLog()` (`spikes/04-ai-gateway-cost-reconciliation`,
    docs/06-AGENTIC-CHAT.md Spike F)

Full report: `spikes/04-ai-gateway-cost-reconciliation/REPORT.md`. Access mechanism used: option 1
(a minimal, spike-scoped Terraform config reusing the `dotenv` provider and AGENTS.md's
bypass-policy shape, matching Spikes A and B) — needed for the same reason as those two: a live
`env.AI.run()` call has no local remote-binding simulation on this account (decision #11), and
`env.AI.gateway(id).getLog()` is itself a Workers Runtime binding feature with no plain-HTTP
equivalent.

**Decision #13 already established `env.AI.aiGatewayLogId` is `null` for every dynamic-route
call. This spike found the working replacement**: mint a fresh `crypto.randomUUID()` immediately
before `env.AI.run()`, attach it as `gateway.metadata.correlationId`, and afterward query
`GET /accounts/{account}/ai-gateway/gateways/{id}/logs` with
`filters=[{"key":"metadata.value","operator":"eq","value":["<uuid>"]}]` — live-verified with
**zero misses across 11 sequential trials and 10 concurrent calls**. Two real gotchas in the
`filters` query parameter, confirmed by testing directly against the account's pre-existing
`demo-gateway` before ever touching this spike's own gateway:

- **The Cloudflare API reference documents this `filters` parameter** (an array of
  `{ key, operator, value }` objects), but the narrative AI Gateway logging docs page does not
  mention it at all — only the dashboard's own filter UI. It must be sent as **one query
  parameter whose value is a single JSON-encoded array string** —
  `filters=[{"key":"model","operator":"eq","value":["..."]}]` — not the bracket-notation encoding
  several other Cloudflare list endpoints accept (`filters[0][key]=...`), which is **silently
  ignored with no error and no filtering whatsoever** (confirmed by comparing
  `result_info.total_count` with and without it — identical both times).
- **`value` must be a JSON array even for a single-value equality check** — a bare string fails
  validation (`{"errors":[{"code":7001,"message":"Expected array, received string", "path":
  ["query","filters",0,"value"]}]}`); wrapping it in `[...]` succeeds. `per_page` also has an
  undocumented (in the narrative docs) hard ceiling of `50`.

**`metadata.key` and `metadata.value` are separate, independently-applied existence checks
across a log row's whole metadata map — they are not paired to the same entry**, despite reading
as if they should be. Live-proven: filtering `metadata.key = "team"` (present on essentially every
row in a real dataset) **and** `metadata.value = "agent-lead-enrichment"` (a value that, in that
same dataset, only ever appears under the *different* key `actor_id`, never under `team`) returned
the exact same row count as filtering `metadata.value` alone — proving the `key` filter added zero
restriction. **Consequence for any future correlation design using this endpoint**: only a value
that is already globally unique on its own (a per-turn UUID) is safe to filter on this way: a
reused identifier (a chat ID, a segment name) is not, even paired with a `metadata.key` filter
naming the field it is supposed to live under, since that pairing is not enforced. Cross-field
filters (different top-level `key`s in the array, for example `model` + `metadata.value`) genuinely
ARE ANDed together correctly — this lack of pairing is specific to the two `metadata.*` sub-filters
interacting with each other. `eq` is a true exact match, not a substring match (confirmed: filtering
`metadata.value = "agent"` never matched a row whose only metadata value was the longer string
`"agent-lead-enrichment"`).

**`gateway.eventId`/`cf-aig-event-id` re-tested with the corrected `filters` query shape (in case
decision #13's negative result was a query-syntax problem) and confirmed, again, not to work at
all** — the resulting log row's own `event_id` field is still always empty. This is a true
negative, not a syntax issue: every other filter in this spike's testing worked correctly with the
same query shape. The `metadata`-based correlation above is not a second-best fallback; it is the
only mechanism either spike found that works.

**Concurrency is safe with no serialization required.** Five `env.AI.run()` calls fired via
`Promise.all` inside one Worker invocation, each with its own UUID, correlated to five distinct
log rows with zero cross-talk — reproduced twice (10/10 total). This holds because the correlation
mechanism (a globally unique value, exact-matched) has no shared mutable state for concurrent calls
to race on.

**Measured reconciliation lag is low seconds, not the multi-second-to-minutes "eventually
consistent" figure `docs/06-AGENTIC-CHAT.md` originally hedged about** (that hedge was AI
Gateway's own docs describing *spend limits* specifically, not logged cost data): 267 ms–4,731 ms
across 11 real trials (~2.2 s average), measured as full wall-clock round trips from a machine
outside Cloudflare's network, not a pure server-side ingestion figure — so this is a ceiling, not a
floor. This was measured against a freshly created, otherwise-idle dedicated gateway; production
load on a shared gateway could differ, which is why a bounded-retry design remains the right shape
even though the observed numbers are reassuring. Chosen schedule for Phase 6: an initial 10-second
delay, then two retries at +15 seconds each (three attempts total, ~40 s worst case).

**A failed dynamic-route call (`AiGatewayError 2002` and similar) still produces its own
correlatable log row** — `model: "dynamic/<route-name>"`, `provider: "unknown"`, `cost: 0`,
`success: false` — carrying the same request metadata a successful call would. A future demo's
reconciliation logic needs no special case for a failed-but-logged turn; only a turn AI Gateway
never logs at all (a network error before the request reaches it, for example) needs the
"give up after N attempts" path to trigger from a genuinely missing row rather than a `cost: 0`
failed one.

**`getLog(id)` continues to work once a row's real id is known by this new correlation path** —
confirmed to return the exact same `tokens_in`/`tokens_out`/`cost`/`metadata` the list already
returned, plus `request_head`/`response_head` (truncated request/response bodies) the list
response omits, which a future export feature could use for a richer transcript record.
`getLog()`'s "not found" signal continues to be a **thrown** `AiGatewayLogNotFound: Log not found`
error (decision #13), re-confirmed again in this spike — this is distinct from the logs-list
endpoint's own "not yet available" signal, which is simply an **empty result array**, no error at
all.

**There is no binding method to list logs** — `AiGateway`'s generated type exposes only
`getLog(id)`, `patchLog(id, data)`, and `getUrl(provider)` (confirmed by reading
`worker-configuration.d.ts` directly). Any future demo needing this same correlation pattern must
call the plain REST API from inside the Worker (with a Wrangler secret for the account API token)
for this one operation — the one place `AGENTS.md`'s "prefer bindings over REST calls" guidance
cannot be followed, because no such binding exists.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this
heading when they have been incorporated.

## 17. `@cloudflare/vitest-pool-workers`'s shared `env` lets a test fake a binding a Durable
    Object itself reads (`demos/agentic-ai-chat`, Phase 2)

Building `ChatAgent`'s Phase 2 integration tests (docs/06-AGENTIC-CHAT.md, Phase 2) needed a way
to drive a real WebSocket chat turn against the real Durable Object without a real Workers AI
call — the same "inject a fake `Ai`" need `docs/05-AI-CHAT.md`'s Phase 3 established, but this
time the binding is read by a Durable Object (`this.env.AI` inside `ChatAgent.onChatMessage()`),
not the top-level Worker `fetch()` handler `authenticatedRequestWithAi()` substitutes `env` for.

**Confirmed live: mutating `env.AI` (imported from `cloudflare:workers`) before making a request
reaches the Durable Object's own `this.env.AI` at call time**, with no extra wiring. Concretely:

```ts
import { env } from "cloudflare:workers";

const original = env.AI;
(env as unknown as { AI: Pick<Ai, "run"> }).AI = fakeAi;
try {
  // ...drive a real WebSocket chat turn through the real Worker route...
} finally {
  (env as unknown as { AI: Ai }).AI = original;
}
```

This works because `@cloudflare/vitest-pool-workers` runs the whole test file's Worker script and
every Durable Object it creates inside one in-process `workerd` instance for that file, sharing
the exact same `env` bindings object by reference — not a separately provisioned script the way a
deployed Worker's Durable Object bindings are configured independently in production. Verified
with a real, capturing fake (`createCapturingFakeAi()`, mirroring `docs/05-AI-CHAT.md`'s
`createCapturingFakeAi()`) that recorded the exact `model`/`input` `workers-ai-provider`'s
`doStream()` passed to `env.AI.run()`, proving the Durable Object's own code path — not merely the
Worker's top-level routing — actually observed the fake.

**The fake's `run()` must still return the raw Workers AI SSE stream shape**
(`data: {"response": "..."}\n\n` / `data: [DONE]\n\n`), exactly `docs/05-AI-CHAT.md`'s
`createFakeAi()` fixture already produces — confirmed by reading the installed
`workers-ai-provider` package's `doStream()`/`getMappedStream()` source: it calls
`this.config.binding.run(model, inputs, options)` (the literal `env.AI.run()` signature) and, when
the result is a `ReadableStream`, decodes it with the identical SSE `data:`-line parser demo 5's
own raw-`env.AI.run()` code path uses. A future demo faking `env.AI` for anything built on
`workers-ai-provider`/`AIChatAgent` can reuse demo 5's existing SSE-fixture helpers verbatim; no
new fake-response shape was needed.

**A remaining cost, not a correctness blocker**: the test pool still spends roughly ten seconds
per test file attempting the real `ai: { remote: true }` binding's "Establishing remote
connection…" handshake against the real account (docs/05-AI-CHAT.md, "Workers AI Has No Local
Simulation") before any test in that file runs, even though the fake substitution means no test
ever actually calls it. This is `remote: true`'s own Miniflare startup cost, not something the
fake-`env.AI` substitution can skip.

## 18. `AIChatAgent`'s built-in `get-messages` endpoint is how a client reloads a chat's history
    (`demos/agentic-ai-chat`, Phase 2)

US-1's acceptance criterion ("reloading the page and reconnecting resumes the same conversation
from durable storage, not from browser memory") needs a way for the browser to fetch a chat's full
persisted transcript before opening its live WebSocket connection. Neither `docs/06-AGENTIC-CHAT.md`
nor Spike A's report named a mechanism for this — Spike A only confirmed message persistence
*server-side* across two separate connections, not how a *client* retrieves that history.

**Source-read from the installed `@cloudflare/ai-chat@0.10.1` package: `AIChatAgent`'s own
`onRequest` hook already answers a plain (non-upgrade) `GET` request whose path's final segment is
exactly `get-messages`, returning `Response.json(this._loadMessagesFromDb())`** — the same
`UIMessage[]` shape (`{id, role, parts}`) `this.messages` holds, read fresh from the Durable
Object's SQLite store rather than depending on the instance already being warm. No route
registration, no code of this demo's own — the Worker (`src/worker/routes/chats.ts`) only needs to
forward an already-ownership-checked request ending in `/get-messages` to
`getAgentByName(...).fetch(request)` for this to work. This is the mechanism a future demo (or a
later phase of this one) should reuse for "load history before connecting" rather than inventing a
custom REST endpoint or relying on a wire-protocol frame — there is no `cf_agent_chat_messages`
broadcast sent automatically on every connect in this installed version (that frame type exists,
but source-reading `@cloudflare/ai-chat@0.10.1` shows it is only ever sent from a narrower
dropped-submit-rollback path, not as a general connect-time history replay).

## 19. Evicting an Agents-SDK `Agent` that just called its own `destroy()` hangs
    `evictAllDurableObjects()`; use `abortAllDurableObjects()` instead (`demos/agentic-ai-chat`,
    Phase 3)

Phase 3's `DELETE /api/chats/:id` route calls `stub.destroy()` on the chat's `ChatAgent` Durable
Object (an override that notifies connected clients before delegating to the Agents SDK's own
base `Agent.destroy()`). Reading the installed `agents` package: that base method drops every
internal table, deletes the alarm, `await`s `ctx.storage.deleteAll()`, and then calls
`this.ctx.abort("destroyed")` from a deferred `setTimeout(..., 0)` — deliberately deferred so the
RPC call itself (and the route that awaited it) resolves cleanly before the abort actually runs.

**The `testing-durable-objects` skill's rule 3 cleanup (`evictAllDurableObjects({ webSockets:
"close" })` in `afterEach`) hangs indefinitely the first time it runs after a test destroyed a
`ChatAgent` this way.** Observed live: an uncaught
`workerd/api/actor-state.c++:1178: failed: broken.outputGateBroken; jsg.Error: destroyed`
exception logged to the console, immediately followed by the `afterEach` hook itself timing out
at Vitest's default 10-second `hookTimeout`. `evictAllDurableObjects()`'s own documented
behavior — "eviction waits for in-flight requests to drain (with a timeout)" — is the likely
cause: it tries to gracefully drain an actor whose output gate the deferred `ctx.abort()` has
already permanently broken, and that graceful wait never resolves against a broken gate.

**Fix: call `abortAllDurableObjects()` (also from `cloudflare:test`) instead, in any integration
test file where a test might call `.destroy()` on an Agents-SDK `Agent`.** It performs the same
"reset every Durable Object instance so no live connection outlives a test" job the skill's rule
3 needs, but by hard-resetting every instance rather than attempting a graceful, drain-and-wait
eviction — confirmed live to not hang on an already-aborted actor, and to still force-disconnect
an *ordinary*, non-destroyed instance's hibernatable WebSocket in the same file's other tests
(`demos/agentic-ai-chat/tests/integration/chat-management.test.ts`). A file whose tests never
call `.destroy()` (for example this demo's own Phase 2 `chat.test.ts`) has no reason to hit this
and can keep using `evictAllDurableObjects({ webSockets: "close" })` as the skill already
documents — this is an addition for the destroy()-calling case, not a blanket replacement.

This is now folded into the `testing-durable-objects` skill as a seventh rule, alongside the
original six from `demos/chat`.

## 20. A `streamText()` turn's client-visible "done" arrives well before its own `onFinish`
    side effects land — a real, reported bug in `demos/agentic-ai-chat`'s Phase 3 auto-titling

Phase 3 shipped `ChatAgent.afterTurnCompleted()` (a D1 recency touch, plus a second,
non-streaming `env.AI` call generating the chat's title on its first turn) as a wrapper around
`AIChatAgent`'s own `onFinish` callback, on the stated assumption that "the AI SDK's stream
finalization blocks on `onFinish` resolving, so the client cannot observe the turn as done until
this method's own D1 writes have already landed" — the same guarantee Phase 2's own reload test
relies on for message persistence. **That assumption is wrong for what the client actually
treats as "done."**

**Confirmed live with a timestamped diagnostic** (a two-chunk fake model response, plus an
artificially slow, 500ms title-generation call): the client-visible `{"type":"finish"}`
UI-message-stream part arrived after **104ms**, while the title-generation call did not resolve
until **607ms**, and the wire-level `done: true` flag on the *final* `cf_agent_use_chat_response`
frame did not arrive until **611ms** — essentially the same moment `afterTurnCompleted()`
finished, not the moment the model stopped generating. Reading the installed `ai` package
confirms why: `toUIMessageStreamResponse()`'s underlying stream enqueues the "finish" UI part as
soon as the model's own generation ends, with zero dependency on whether the caller's `onFinish`
callback has resolved. Only the stream's own final *close* signal (what determines when a reader
sees `{done: true}`, and therefore when `AIChatAgent`'s relay loop can send its own trailing wire
frame) is actually gated behind `onFinish` — and nothing on the client reacts to that wire-level
flag alone; `useChatAgent.ts` treats a turn as `"done"` specifically on the `"finish"` UI part,
which is the *earlier* of the two signals.

**Real-world consequence, reported directly by a user testing the deployed demo**: Phase 3's
sidebar refresh logic watched the turn's own `isStreaming` status (derived from that same
`"finish"` part) to decide when to reload the chat directory — reliably reloading *before*
`afterTurnCompleted()`'s title/recency writes landed, so the sidebar kept showing "New chat"
until an unrelated later page reload happened to observe the already-finished write.

**Fix: broadcast, don't infer.** `afterTurnCompleted()` now sends its own explicit
`chat_metadata_updated` frame (`src/agent-protocol.ts`) to every connected client once its own
writes (success, failure, or a skipped title generation) are done — the same
"the side effect itself announces its own completion, the client never infers it from an
unrelated signal" pattern `docs/06-AGENTIC-CHAT.md` Section 6.6a already established for Phase
6's cost-reconciliation broadcast. `useChatAgent.ts` exposes this as a `metadataUpdatedAt`
timestamp ref; the sidebar's refresh watcher (`HomeView.vue`) now watches that instead of
`isStreaming`. Any future phase adding its own `onFinish`-driven side effect (Phase 6's cost
ledger already plans exactly this shape) should broadcast its own completion the same way,
rather than assuming a turn's streaming status is a proxy for "every `onFinish` side effect has
also finished" — it is not.

## 21. `Agent.destroy()`'s own RPC call is not guaranteed to resolve cleanly for its caller — a
    second real, reported bug in `demos/agentic-ai-chat`'s Phase 3 chat deletion

Reported directly by a user testing the deployed demo: deleting a chat produced "An unexpected
error occurred" (the generic RFC 9457 `500` fallback), and the chat was **not** actually removed
— worse, reopening it afterward showed an empty transcript, as if its content had already been
wiped despite the chat still appearing in the sidebar.

**Root cause, confirmed by directly patching `ChatAgent.prototype.destroy` in an integration
test to throw:** `src/worker/routes/chats.ts`'s `DELETE /:id` route called `await
stub.destroy()` with no error handling at all. The Agents SDK's base `Agent.destroy()` defers
its own `ctx.abort()` behind a `setTimeout(..., 0)` specifically so its RPC caller receives a
clean, resolved response before that abort runs (Section 9/Phase 3's own design note, and
`docs/DECISIONS.md` item 19's investigation into this same method) — **but that guarantee is not
airtight.** A live case exists where the RPC call itself rejected. Left unguarded, that
exception aborted the whole route *before* the D1 row was ever removed — reproducing every
symptom exactly: the thrown exception surfaces as the generic `500` (Hono's
`problemDetailsErrorHandler` has no more specific mapping for an arbitrary rejected RPC call);
the D1 directory row survives (the route never reached `repository.remove()`); and the Durable
Object's own storage had typically *already* been wiped by whatever `destroy()` did manage to
execute before/around the failure — hence the chat reappearing with an empty transcript despite
still being listed.

**Fix:** wrap `stub.destroy()` in its own `try`/`catch`, log a failure (`chat_destroy_failed`),
and *unconditionally* proceed to remove the D1 row regardless of whether the RPC call resolved
or rejected. This is the same "a side effect's own failure must not block the outcome the route
exists to guarantee" principle Section 11 already establishes for tool failures, and this
demo's own `afterTurnCompleted()` already applies to its D1 writes (item 20) — applied here to
the delete route's own call to a *different* Durable Object RPC method. `stub.destroy()`
rejecting no longer means "deletion failed"; it means "the live teardown may not have completed
cleanly, but the directory entry — the actual thing this route promises — is gone either way."

**Any future demo calling `Agent.destroy()`** (or any other Durable Object RPC method whose
failure must not be allowed to abort an operation with its own separate, more important
success criterion) should assume the same: a Durable Object RPC call's own promise settling
cleanly is not a load-bearing assumption, even when the SDK's own source comments say it is.

## NEW DECISIONS

## 22. Testing an Agents-SDK `Agent` subclass's own logic, a Wrangler-native way to type a
    secret with no committed value, and D1's `UPDATE ... RETURNING` — three findings from
    `demos/agentic-ai-chat`'s Phase 6 cost ledger

**An `Agent`/`AIChatAgent` subclass cannot be imported into a plain-Node Vitest project at
all, let alone unit-tested with a mocked `this`.** Attempting a `chat-agent.test.ts` under this
demo's `worker` project (`environment: "node"`) failed immediately with `Error: Only URLs with
a scheme in: file, data, and node are supported by the default ESM loader. Received protocol
'cloudflare:'` — both `agents` and `@cloudflare/ai-chat` import `cloudflare:workers`/
`cloudflare:email` at module top level, so the class cannot even be loaded outside a real
`workerd` runtime, independent of what a test does with it afterward. **The working
alternative:** call the real, unmodified method directly against the real, already-running
Durable Object instance via `runInDurableObject()` (`cloudflare:test`), obtained the same way
`chat.test.ts`'s own pre-existing "no props" test already does
(`env.CHAT_AGENT.getByName(id)`) — no mocked `Agent` base is needed, and every branch
(`ChatAgent.reconcileUsage()`'s success/not-yet-available/exhausted-retries/target-disappeared
paths) is exercised by substituting only the one collaborator that would otherwise make a real
network call (the AI Gateway logs-list REST endpoint), via a `withFakeFetch()` helper that
temporarily reassigns `globalThis.fetch` — the same `env`-substitution spirit
`withFakeAi()`/`withThrowingDb()` (item 17) already established, applied to a global rather
than a binding. This sidesteps waiting on the method's own real 10s/+15s/+15s schedule delays
entirely, since it is called directly rather than through `this.schedule()`.

**A Wrangler secret can be typed on the generated `Env` with no literal value ever written to
`wrangler.jsonc`, via the config schema's `secrets.required` array** — confirmed against the
pinned `wrangler@4.115.0`'s own `config-schema.json`. Declaring
`"secrets": { "required": ["CLOUDFLARE_API_TOKEN"] }` alongside `vars` in `wrangler.jsonc.tpl`
is what makes `generate-wrangler-types`/`wrangler types` emit `CLOUDFLARE_API_TOKEN: string;`
on `Env` at all; the field's own real value is pushed separately and only at deploy time via
`wrangler secret put`, reading this repo's own `.env` (`node --env-file=../.env -e
"process.stdout.write(process.env.CLOUDFLARE_API_TOKEN)" | wrangler secret put
CLOUDFLARE_API_TOKEN` — an inline `package.json` script, per AGENTS.md's "only add a custom
script when the task cannot be expressed atomically" rule; piping the value through `node
--env-file` rather than `echo` avoids ever placing the secret literally in a shell command).
Without this field, Wrangler otherwise infers a Worker's secrets from `.dev.vars`/`.env`/
`process.env` for type-generation purposes — but this repo's own committed `.dev.vars`
deliberately holds no secrets, so that inference would never see this one at all. Documented
here since this is the first Wrangler secret introduced anywhere in this repo.

**D1 supports `UPDATE ... RETURNING`, and the returned row surfaces through the ordinary
`run()` method's existing `results` array — no separate `SELECT` needed.**
`UsageRepository.incrementReconcileAttempts()` needs the row's *new* attempt count in the same
round trip as the increment itself (to decide, in the caller, whether the bounded retry budget
is now exhausted); `UPDATE chat_usage SET reconcile_attempts = reconcile_attempts + 1 ...
RETURNING reconcile_attempts`, called via `.bind(...).run<{ reconcile_attempts: number }>()`,
returns that row in `result.results[0]` exactly like a `SELECT` would, alongside the usual
`meta.changes`. A future demo needing "update and read back the new value atomically" should
reach for this instead of a separate `UPDATE` followed by `SELECT` (two round trips, and a
window — however small — for another write to land in between).

## NEW DECISIONS

## 23. `@xyflow/react` in a plain Vite/React host, and an Access-policy `redirect: false` gotcha
    (`spikes/06-architect-reactflow-host`, docs/09-ARCHITECT.md Phase 0)

Full report: `spikes/06-architect-reactflow-host/REPORT.md`. This spike needed no Terraform and
no real Cloudflare Access application — it never exposes an inbound HTTPS endpoint on the real
network, only `vite dev` gated locally by `cloudflareAccessPlugin()` — so there was no
real-account footprint to tear down afterward.

**Astro added nothing load-bearing for the diagram canvas itself that a plain Vite/React/
Cloudflare host needs to reproduce.** Reading CF-Architect's real `src/middleware.ts` directly
confirmed its whole job is Access JWT verification, a dev-mode mock-user bypass, and an admin
check — exactly the three things docs/09-ARCHITECT.md already planned to replace with
`cloudflareAccess()`/`cloudflareAccessPlugin()`/an `ADMIN_EMAIL` middleware, nothing extra hiding
in it. More surprising: CF-Architect's own editor page
(`src/pages/diagram/[id].astro`) already mounts its React Flow island with `client:only="react"`,
not `client:load` — Astro never server-renders the editor at all, so the single most
Astro-coupled-looking page in the app already behaves like a plain client-rendered SPA. The one
real gap found: Astro's file-based routing threads a diagram's `:id` into the island as an
ordinary server-resolved prop (`src/islands/DiagramCanvasWrapper.tsx`); a plain Vite/React SPA has
no server-side router at all, so a future phase's multi-page app needs its own client-side way to
read that id out of the URL — a normal, well-understood addition, not a surprise blocker.

**`cloudflareAccessPlugin()` fully coexists with `@cloudflare/vite-plugin` +
`@vitejs/plugin-react`** — a complete login → authenticated `/api/*` call → `get-identity` →
logout round trip was live-verified end to end over `curl` against a real running `vite dev`
server, with the same `PathPolicy[]` array reused by both the plugin and the Worker's own
`cloudflareAccess()`, exactly like `demos/url-shortener` already does.

**An API path policy must set `redirect: false` explicitly, or the dev plugin can redirect an API
caller to the login page instead of returning JSON.** Reading the toolkit's shipped
`dist/vite/index.js` directly shows its request handler falls through to `isNavigation(req)` —
which returns true whenever the request carries `Sec-Fetch-Mode: navigate`, or, failing that, an
`Accept` header containing `text/html` — for any protected path whose policy entry does not
explicitly set `redirect: false`, regardless of whether that path is `/api/*` or a page route. A
plain `curl` (default `Accept: */*`) against an unauthenticated `/api/whoami` correctly received
the Worker's own JSON `401`, but the identical request with `-H "Accept: text/html"` (or a real
browser navigated there directly by URL) instead got a `302` redirect to the login form —
live-verified both ways. `demos/url-shortener/src/access-policies.ts` already sets
`redirect: false` on its own `/api/links`/`/api/me` entries for exactly this reason; this spike's
first draft omitted it and reproduced the bug it was already guarding against elsewhere in this
repo. Any future demo's Access policy array must set `redirect: false` on every `/api/*` entry
deliberately, not rely on it being unnecessary just because the path "looks like" an API route.

**Base editor bundle size confirms the prior ELK lazy-load decision's premise still holds for the
React port.** React 19 + `@xyflow/react` + this probe's own code, with no auto-layout library
included yet, gzips to 118.82 kB — far under the 539.52 kB gzip figure that made this repository's
prior Vue attempt at this same demo defer ELK to a lazy `import()` (docs/09-ARCHITECT.md's
porting table). A future phase adding ELK should still lazy-load it (the decision itself is
unchanged) but can now cite this base measurement as the "before" figure.

**Real pointer-based drag-and-drop interaction was not verified with an automated real browser —
this environment had no browser-automation tool available, and jsdom does not implement
HTML5 drag-and-drop or real layout geometry meaningfully enough to trust a headless simulation of
it.** The probe's palette-drag, node-drag, and connection-drag code is structurally identical to
CF-Architect's own already-working implementation (same `dataTransfer`/`screenToFlowPosition`
mechanism, same `nodesDraggable`/`nodesConnectable`/`elementsSelectable` read-only-mode prop
combination, confirmed by reading `DiagramCanvas.tsx` directly), and the built bundle loads and
runs with zero Worker-side or console-visible errors — but this is a code-review-level claim, not
a live-verified one. Any future phase building on this spike should do a two-minute manual
click-test of it in a real browser first, rather than assume interaction fidelity transfers from
a clean build alone.

## 24. `wrangler deploy` resets a Worker's `observability` metadata unless a real Terraform apply
    runs after it (`demos/architect`, Phase 1, first real deployment)

Live-verified against a real Cloudflare account: after `terraform apply` sets
`cloudflare_worker.demo.observability` (logs enabled, 100% sampling; traces enabled, 10%
sampling) and `wrangler deploy` then runs with no `observability` block in
`wrangler.jsonc.tpl` (this repository's shared convention — see AGENTS.md's "generated
`wrangler.jsonc` MUST NOT duplicate ownership of settings managed by Terraform"), the next
`terraform plan` shows the Worker's `observability.enabled`/`logs.enabled`/`traces.enabled` all
drifted back to `false`. `wrangler deploy` does not merely leave observability alone when the
config omits it — it actively resets it, every single deploy. Every other demo in this repository
has this same latent bug: none had actually been deployed for real before this (their committed
`infra/*.tfstate` files, gitignored and never applied against real resources, all show zero
tracked resources), so the gap was never observed until `demos/architect`'s deploy was the first
one actually run against a live account.

**Fix:** `demos/architect/package.json`'s `deploy` script now runs a second, idempotent
`terraform apply` (`deploy:infra:reconcile`) after `deploy:worker`, not just once before it:
`run-s deploy:infra deploy:worker deploy:infra:reconcile`. This re-asserts every
Terraform-managed setting `wrangler deploy` might have touched, without adding a second source of
truth to `wrangler.jsonc.tpl` (which would reintroduce the exact duplicate-ownership problem
AGENTS.md already warns against). Confirmed with a real `terraform plan -detailed-exitcode` after
a full `npm run deploy`: zero drift. Every other demo in this repository should adopt the same
three-step `deploy` script the next time it is actually deployed for real, and AGENTS.md's
Resource Ownership section should eventually fold this in as a baseline requirement rather than a
per-demo discovery.
