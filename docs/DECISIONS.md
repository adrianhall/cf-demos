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

**Superseded by #25** — the second `terraform apply` turned out not to be the only, or the best,
fix; `wrangler.jsonc.tpl` mirroring the same `observability` values removes the need for it
entirely.

## 25. Mirror `observability` into `wrangler.jsonc.tpl` instead of a second `terraform apply`
    (`demos/architect`, superseding #24)

#24's `deploy:infra:reconcile` fix works, but a full extra `terraform apply` after every deploy
just to reassert one field `wrangler deploy` insists on touching is more machinery than the
problem needs. The simpler fix: give `wrangler.jsonc.tpl` an `observability` block whose values
are a literal, value-for-value copy of `infra/architect.tf`'s `cloudflare_worker.demo.observability`
block. Now `wrangler deploy` writes the *same* state Terraform already established instead of
resetting it to disabled, so nothing drifts and no reconciling apply is needed — confirmed with a
real `terraform plan -detailed-exitcode` immediately after `npm run deploy` (no second apply in
that script anymore): zero drift, first try.

This does not reintroduce the "generated `wrangler.jsonc` MUST NOT duplicate ownership of
settings managed by Terraform" problem AGENTS.md warns against and #24 was careful to avoid:
`architect.tf`'s resource remains the only place a human decides these values, and
`wrangler.jsonc.tpl`'s block is a same-value mirror kept in sync by hand (both blocks carry a
comment pointing at the other), not an independently-configurable second source of truth. This
was deliberately *not* threaded through as a Terraform output/`{{placeholder}}` the way
resource-generated values (a D1 database id, a KV namespace id) are: `1`/`0.1`/`true` here are
static demo choices baked into the `.tf` file itself, not data that only exists after `apply`, so
templating them through an output would add indirection without adding any actual
single-source-of-truth benefit.

`demos/architect/package.json`'s `deploy` script is back to the ordinary two-step
`run-s deploy:infra deploy:worker`. Any other demo that adopts Terraform-managed `observability`
in the future should mirror this fix directly rather than #24's — there is no longer a reason to
reach for a second `apply`.

**Rolled into AGENTS.md** — the Resource Ownership section's "generated `wrangler.jsonc` MUST NOT
duplicate ownership of settings managed by Terraform" line now carries this as its one explicit,
narrow exception, fulfilling #24's own suggestion that this stop being a per-demo discovery. Any
future demo that hits the same `wrangler deploy`-resets-a-Terraform-managed-field problem should
follow AGENTS.md directly; this entry (and #24) exist for the live-verified rationale.

## 26. Inline vendored SVG via `import.meta.glob(..., { query: "?raw" })`, not `<img>` or CSS
    `mask-image`, for official Cloudflare product icons (`demos/architect`, Issue 7,
    docs/09-ARCHITECT.md Phase 7)

Issue 7 replaced `demos/architect`'s ~30 hand-drawn placeholder product icons with byte-identical
copies of Cloudflare's own official icons (`~/repos/adrianhall/cloudflare-docs/src/icons/`,
vendored into `src/client/icons/`). Those files have no `fill`/`stroke` attribute of their own
(SVG's implicit default is opaque black), which ruled out the two more obvious rendering
approaches:

- **Plain `<img src="...">`** (what the hand-drawn placeholders used): renders every icon as a
  flat black shape, with no way to recolor it via CSS at all — invisible-by-poor-contrast in dark
  mode, and unable to pick up a node's category/accent color the way the placeholders' own
  hand-authored `stroke="..."` did.
- **CSS `mask-image: url(...)`** (theme-aware without inlining any markup): would have worked for
  on-screen rendering, but `ExportButton.tsx`'s PNG/SVG export
  (`html-to-image`) does not inline `mask-image` when it serializes the DOM subtree to a
  data URL — the icons render on screen but silently vanish from every exported diagram image,
  discovered by manually exporting a diagram containing the affected node types during Phase 7
  verification.

**Fix:** a shared `src/client/components/ProductIcon.tsx` component loads every vendored file's
raw text at build time via `import.meta.glob("../icons/*.svg", { eager: true, import: "default",
query: "?raw" })` and inlines it directly into the DOM via `dangerouslySetInnerHTML` (biome's
`noDangerouslySetInnerHtml` is suppressed there with a comment explaining the source is a static,
vendored, build-time-only asset map — never user input, catalog data, or a runtime/network
value). `app.css`'s `.product-icon--svg svg { fill: currentColor; }` then forces every vendored
icon to pick up the wrapper's inline `color` style, the same `currentColor` pattern
`react-feather`'s own icons already use via `stroke`. Because the icon is now real inlined SVG
markup in the DOM (not a CSS background effect), `html-to-image` captures it in PNG/SVG exports
exactly as rendered on screen.

The four "External / Generic" category node types (not real Cloudflare products) and
`cron-trigger` (a Workers trigger configuration with no official product icon of its own) use
`react-feather` icons instead, resolved through a small explicit `Record<string, Icon>` map in
`ProductIcon.tsx` — deliberately not `import * as FeatherIcons from "react-feather"` with a
dynamic `FeatherIcons[name]` lookup, which was tried first and reverted: a namespace import
defeats tree-shaking for a dynamic property access, since the bundler can no longer tell which of
the library's ~280 icons are reachable and must include all of them. The initial version of this
fix (before switching to named imports) measured a production `client` build at 188.71 kB gzip
for the main JS chunk, against a 149.21 kB baseline before this port added any `react-feather`
icon at all; switching to five explicit named imports (`Clock`, `Database`, `Globe`, `Monitor`,
`Smartphone` — the only feather icons the catalog actually references) brought that back down to
164.21 kB gzip, confirmed by rebuilding and comparing `dist/client/assets/index-*.js` before and
after.

## 27. Vite 8's default CSS minifier (Lightning CSS) silently breaks `light-dark()` against a
    JS-driven `color-scheme` override, unless a specific feature is excluded from its downlevel
    transform (`demos/architect`, Phase 7's icon-only toolbar)

After Phase 7 converted every toolbar/dashboard/modal control to an icon-only `<button>`, a real
bug was reported in light mode: several buttons rendered with a dark background behind a dark
icon — effectively invisible — while the icon itself (a plain inline SVG, `currentColor`-driven)
tracked the active theme correctly. Toggling the in-app dark-mode control changed the icon's
color immediately but left the button's own background stuck.

**First attempt (wrong): `appearance: none`.** The initial theory was that native `<button>`
chrome (`appearance: auto` is the default UA style) was painting using the browser/OS's actual
light/dark setting rather than this page's `color-scheme` override
(`demos/architect/src/client/lib/theme.ts`'s `applyTheme()`, which sets
`document.documentElement.style.colorScheme` directly) — a real, independently-worth-keeping
class of bug in general (it's why essentially every CSS reset neutralizes native button
appearance), but confirmed *not* the cause here: adding `button { appearance: none; }` to
`app.css` did not fix the reported symptom.

**Second check: was `light-dark()` itself broken?** Running `vite dev` and testing directly with
a throwaway Playwright script (both Chromium and WebKit, OS light and dark, with and without the
in-app toggle) rendered every button correctly in every combination — ruling out `app.css`'s
color logic and pointing squarely at something specific to a *production build*, since `vite dev`
never minifies CSS.

**Actual root cause, found by diffing the built CSS:** Vite 8's `build.cssMinify` defaults to
`'lightningcss'`. Lightning CSS's minifier — independent of any configured browser targets —
downlevels every `light-dark()` value (`app.css`'s entire theming system, e.g. `--cf-surface:
light-dark(#fff, #1c1c1e)`) into a pair of `--lightningcss-light`/`--lightningcss-dark` custom
properties toggled by an injected `@media (prefers-color-scheme: dark) { :root { ... } }` rule.
That media query evaluates against the browser/OS's *raw* preference and has no way to observe
the `color-scheme` *CSS property* this app sets programmatically to let a user override the OS
preference in-app — so after minification, every `light-dark()`-based background/border silently
stopped responding to the in-app toggle, while unset `color` properties (relying on the browser's
own native, non-polyfilled `color-scheme` handling for default text color) kept working. This
reproduced identically in a real `vite preview` of the built output and was invisible in `vite
dev` for the reason above.

**Fix:** `vite.config.ts` sets `css.lightningcss.exclude: Features.LightDark` (`Features` is an
enum exported by the `lightningcss` package, now an explicit `devDependency` here rather than a
transitively-installed one now that `vite.config.ts` imports from it directly). Lightning CSS's
own `exclude` option is documented as "features that should never be compiled, even when
unsupported by targets" — exactly what's needed here, since every browser this demo needs to
support already ships `light-dark()` natively (Chrome/Edge 123+, Safari 17.5+, Firefox 120+, all
older than this repository's other baseline requirements) and never needed the polyfill at all.
Verified by rebuilding, `grep`-ing the output CSS for zero `lightningcss-light`/`lightningcss-dark`
artifacts (down from one per `light-dark()` use site), and re-running the same Playwright script
against the built bundle served via `vite preview` — background and color both now track the
in-app toggle correctly.

The `button { appearance: none; }` rule from the first attempt was kept in `app.css` regardless:
it fixes a real, separate, well-documented class of cross-browser button-styling bug, it's a
zero-risk, standard, defensive addition (every major CSS reset includes an equivalent rule), and
removing it would have provided no benefit once the actual cause was found elsewhere.

Any other demo in this repository that uses `light-dark()` for theming and lets JavaScript
override `color-scheme` at runtime (rather than relying purely on `prefers-color-scheme`) should
apply the same `css.lightningcss.exclude: Features.LightDark` fix in its own `vite.config.ts` —
this is a Vite/Lightning-CSS default behavior, not something specific to `demos/architect`'s CSS.

## 28. `@xyflow/react`'s pointer-drag connection flow has no built-in keyboard equivalent, and its
    thumbnail-mode props default to focusable/selectable regardless of a surrounding
    `aria-hidden` wrapper (`demos/architect`, Phase 10's Bug 8 and Bug 33)

Two related `@xyflow/react` (v12) accessibility gaps surfaced while fixing `demos/architect`'s
Phase 10 bugs, worth recording since they apply to any Workers demo that embeds this library, not
only this one.

**Connecting two nodes has no keyboard path, despite `connectOnClick` defaulting to `true`.**
`@xyflow/react` does ship a non-drag connection mode: with `connectOnClick` at its default
(`true`), clicking one `Handle` and then another completes a connection without dragging.
Investigating this as a candidate fix for Bug 8 (WCAG 2.2 SC 2.5.7 / 2.1.1 — connecting nodes was
only possible by pointer-drag) found it does not actually close the gap: `Handle`
(`@xyflow/react/dist/esm/index.js`) renders a plain `<div>` with no `tabIndex`, no `role`, and no
accessible name — a real keyboard user has no way to focus a handle at all, so `connectOnClick`
only ever removes the *drag* requirement for a *pointer* user, not the underlying keyboard gap.
Making handles focusable directly was considered and rejected: the in-progress "waiting for a
second click" state lives in `@xyflow/react`'s own internal `connectionClickStartHandle` store
field, with no public API to inspect, cancel, or drive it from outside the library, and this
repository's client test suite mocks `@xyflow/react` wholesale (`src/client/test/mock-xyflow.tsx`)
for every editor component test, so any behavior depending on that internal store state would be
unverifiable by any committed test — only checkable by hand or a throwaway browser script, for a
change touching this demo's primary, WCAG-critical workflow. The fix that shipped instead
(`ConnectNodesModal.tsx`, `docs/09-ARCHITECT.md` Phase 10) is a dialog built entirely from this
app's own native `<select>`/`<button>` elements, which are keyboard-operable by construction and
fully exercisable by the existing Vitest suite with no library internals or browser automation
involved.

A closely related finding, not itself acted on in this fix: `NodeWrapper`'s own keyboard handling
(same file) *does* let a keyboard user select a node — Enter/Space on a focused, focusable node
triggers the library's internal `handleNodeClick`, which updates the node's own `selected` flag —
but that internal selection path does **not** call the `onNodeClick` prop a consuming app passes
to `<ReactFlow>`. `DiagramCanvas.tsx`'s `onNodeClick` (which drives this app's own
`selectedNodeId` and opens the properties panel, Bug 4) is only ever invoked by a *pointer*
click. This means a keyboard user selecting a node via Enter/Space today gets `@xyflow/react`'s
own visual selection ring, but this app's properties panel silently does not open for it — a real,
separate defect, deliberately left unfixed here since `ConnectNodesModal` was designed not to
depend on canvas selection at all (its own "Source" dropdown defaults from `selectedNodeId` only
when set, and works fine when it is not). Any future work on this app's keyboard support should
treat this as its own bug rather than assume node selection already round-trips correctly for
keyboard users.

**`nodesFocusable`/`edgesFocusable` default to `true` independent of `elementsSelectable`, which
breaks a non-interactive, `aria-hidden` thumbnail.** `BlueprintPreview.tsx` renders a read-only
`<ReactFlow>` thumbnail wrapped in `aria-hidden="true"`, already passing
`elementsSelectable={false}` — but `@xyflow/react`'s `NodeWrapper`/edge-wrapper equivalents compute
node/edge focusability from `nodesFocusable`/`edgesFocusable` specifically, which are separate
props that default to `true` regardless of `elementsSelectable`'s value. Every thumbnail node/edge
therefore still rendered `tabIndex={0}` — real Tab stops inside content marked `aria-hidden` (WCAG
4.1.2, axe's `aria-hidden-focus` rule), and on a dashboard with many diagrams, a tab-order flood
with no reachable content behind any of those stops. Fix: pass `nodesFocusable={false}` and
`edgesFocusable={false}` explicitly alongside `elementsSelectable={false}` on any `<ReactFlow>`
instance that is read-only/decorative — the three props do not imply each other.

Any other Workers demo embedding `@xyflow/react` for an interactive canvas should budget for a
non-drag connection UI as a first-class requirement, not an afterthought, given the library's
handles are not independently keyboard-accessible; and any demo rendering `@xyflow/react` purely
as a thumbnail/preview should set all three of `elementsSelectable`, `nodesFocusable`, and
`edgesFocusable` to `false` together.

## NEW DECISIONS

## 29. `docs/09B-ARCHITECT-MCP.md` Phase 11 spike findings — MCP server mechanism confirmed,
    `elkjs` does not run in `workerd`, OpenCode's MCP OAuth redirect is a fixed loopback default
    (`spikes/07-architect-mcp-spike`)

Four open questions from `docs/09B-ARCHITECT-MCP.md`'s Phase 11 spike, researched and (for the
`elkjs` question) executed against a real local `workerd` instance. Full detail, citations, and
code in `spikes/07-architect-mcp-spike/REPORT.md`; summary here per the Spike Conventions.

**1–2. Stateless MCP server mechanism: `createMcpHandler` confirmed, no correction.**
`createMcpHandler` (`agents/mcp/server`) paired with `@modelcontextprotocol/server` is Cloudflare's
current mechanism, confirmed independently across all three sources Phase 11 named: the Cloudflare
blog's 2026-08-06 post ["The next generation of
MCP"](https://blog.cloudflare.com/mcp-v2/) states `createMcpHandler` has "graduate[d] into the
official MCP TypeScript SDK" with the new MCP 2026-07-28 (fully stateless) specification and that
`McpAgent` is no longer needed for protocol state; `cloudflare/agents`' own current
`examples/mcp-worker` (as distinct from the legacy `examples/mcp`) uses the identical pattern; and
`npm view` confirms current published versions (`agents@0.20.1`,
`@modelcontextprotocol/server@2.0.0`) matching the document's stated dependencies, with no
superseding first-party `@cloudflare`-scoped MCP-server-building package found in that npm org.
**DCR-vs-CIMD investigated in depth, following a direct question about it: not a scope change, and
not merely a client-readiness call either — it is currently impossible to do differently.** The
same blog post notes MCP authorization now prefers Client ID Metadata Documents (CIMD) over
Dynamic Client Registration (DCR), and DCR is "deprecated for new implementations" (removal after
summer 2027). Three checks, each independent: (a) **a real harness has already fully migrated** —
`anthropics/claude-code#84263` (2026-08-05) documents Claude Code authenticating to MCP servers
via the CIMD client id `https://claude.ai/oauth/claude-code-client-metadata`, including a real
production bug (Cloudflare's own bot protection 403ing some cloud egress IPs' fetches of that
document); (b) **OpenCode has not**, and this part is a genuine, if currently harmless, gap — its
bundled `@modelcontextprotocol/sdk` already contains generic CIMD-detection logic
(`client_id_metadata_document_supported`, a `clientMetadataUrl` provider property), but OpenCode's
own custom `OAuthClientProvider` implementation never sets `clientMetadataUrl`, so that path is
dead code today and OpenCode always falls through to DCR; (c) **decisively, Cloudflare Access
itself does not support CIMD at all** — checked against both the pinned Terraform provider schema
(`cloudflare/cloudflare@5.22.0`, via `terraform providers schema -json`) and the live [Access
applications API
reference](https://developers.cloudflare.com/api/resources/zero%5Ftrust/subresources/access/subresources/applications/methods/update/):
`oauth_configuration` has exactly `enabled`/`dynamic_client_registration`/`grant`, no CIMD field,
and the whole feature is explicitly labeled **Beta**. Per the MCP spec's own client priority order
(pre-registered → CIMD *only if the server advertises it* → DCR fallback), finding (c) overrides
(a): **even a fully CIMD-migrated client like Claude Code will use DCR against an Access-fronted
MCP server**, because Access gives it nothing else to prefer. `dynamic_client_registration.enabled
= true` is therefore not a stopgap chosen for OpenCode's current limitations — it is the only
mechanism Access's (Beta) Managed OAuth offers, for any client, today. Worth tracking as an
external dependency, not a Demo 9B design gap: if MCP clients broadly drop DCR before Cloudflare
ships CIMD support on Access, every Access-fronted MCP server loses its non-browser auth path, not
just this one. Also worth citing directly: Cloudflare's [Managed
OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
doc's "Enable managed OAuth on an MCP server application" section is the precise match for this
document's first-party, JWT-validating design — the separate "Secure MCP servers" doc's two
documented setups are both for *third-party* MCP server code and do not apply here.

**3. `elkjs` does not run inside `workerd` — confirmed by execution, and this is a correction.**
Two independent, real (non-mocked) `@cloudflare/vitest-pool-workers` tests in
`spikes/07-architect-mcp-spike/tests/` both fail as expected: `new ELK()` from
`elkjs/lib/elk.bundled.js` (the exact entry point `demos/architect`'s real client-side auto-layout
already uses) throws `TypeError: _Worker is not a constructor` immediately, because that "bundled"
file is actually elkjs's own Node-targeted browserify bundle, whose internal
`require('./elk-worker.min.js')` resolves to an object with no usable `Worker` export once
re-bundled a second time by Wrangler/esbuild for `workerd`. The natural workaround — importing
`elkjs/lib/elk-worker.min.js` directly ourselves and passing it as an explicit `workerFactory` —
fails too, independently: that file (a GWT/Java-compiled-to-JS blob) resolves to a completely
empty module once bundled for `workerd`, with or without the `nodejs_compat` compatibility flag
(tried both). **Decision**: `docs/09B-ARCHITECT-MCP.md`'s planned `autoLayout()` graph-mutation
function must ship the deterministic grid-placement fallback that document already named as its
own contingency for exactly this outcome — this is now the confirmed, required implementation for
Phase 13, not a re-evaluation to defer. Any other Workers demo (or later phase of this one)
considering `elkjs` server-side should assume it needs the same fallback rather than re-discovering
this.

**4. OpenCode's MCP OAuth client: fixed loopback redirect, DCR (not CIMD), RFC 8707 + PKCE.**
Read directly from OpenCode's own compiled CLI binary (`opencode@1.18.15`) plus its published
docs. OpenCode's MCP OAuth redirect defaults to a **fixed, hardcoded** `http://127.0.0.1:19876/mcp/oauth/callback`
(overridable per-server via `opencode.json`'s `mcp.<name>.oauth.callbackPort`/`redirectUri`, but
this is the un-configured default, not a randomly-chosen ephemeral port) — the local callback
server binds literally to `127.0.0.1`, not `0.0.0.0`/`localhost`. This **confirms**
`docs/09B-ARCHITECT-MCP.md`'s `allow_any_on_loopback: true` choice, and clarifies that the
document's own suggested alternative ("narrow to an explicit `allowed_uris` entry instead if the
redirect URI is stable enough") is **not actually available** for this client: Cloudflare's Managed
OAuth `allowed_uris` field requires `https://`, and OpenCode's loopback redirect is plain `http://`
by design (OAuth 2.1's native-app loopback exception) — there is no way to allow-list a specific
`http://127.0.0.1:PORT` URI through that field, so `allow_any_on_loopback` is the only mechanism
that can admit this client, not one option among several. OpenCode's client registration is plain
RFC 7591 Dynamic Client Registration with `token_endpoint_auth_method: "none"` (a public client) —
confirming DCR, not the newer CIMD mechanism, must stay enabled in the Access application's
`oauth_configuration` for this client to work. Also confirmed present: PKCE (`code_challenge`)
and an RFC 8707 `resource=` parameter on authorization/token requests (satisfying Managed OAuth's
stated client-support prerequisite), and MCP protocol version strings up to `2026-07-28` in
OpenCode's bundled client SDK (confirming it already speaks the new stateless protocol a
`createMcpHandler` server serves). **Decision**: no change to the document's
`oauth_configuration` block; drop its "narrow to `allowed_uris` instead" framing as a live option
for OpenCode specifically (keep it as general advice for a hypothetical https-redirect client);
cite the exact default redirect URI in `DEMO.md`'s presenter script so a presenter knows what the
browser prompt will show. **Not done as part of this spike, and intentionally left open**: the
real, deployed-account end-to-end round trip (`opencode mcp auth` against a live scratch Access
application) Phase 11's item 4 also asks for — this repository's standing rule against touching
real account infrastructure without explicit request applies, so that live check remains a manual
pre-Phase-12 step, not something this spike closes.

## NEW DECISIONS

## 30. `docs/09B-ARCHITECT-MCP.md` Phase 12 implementation findings — `createMcpHandler` built
    fresh per request (not module scope), and `nodejs_compat` is required

Two corrections/clarifications surfaced implementing Phase 12 (`demos/architect/src/worker/routes/mcp.ts`,
`demos/architect/src/worker/mcp/server.ts`) that Phase 11's spike did not need to answer, since it
never actually wired the handler into a real Access-fronted Worker route:

**1. `createMcpHandler(...)` must be built fresh per `/mcp` request in this demo, not cached at
module scope, despite the document's "module scope per current guidance" phrasing.** Reading
`agents`'s actual `createStatelessMcpHandler` source (`node_modules/agents/dist/handler-stateless-*.js`)
shows its only per-request-varying identity mechanisms are: (a) a **static** `authContext` option
fixed at handler-creation time (would freeze whichever identity built a module-scope singleton
into every later request that reuses it — a real cross-tenant leak for this demo's Access-native
design, not a hypothetical one); or (b) `ExecutionContext.props`, which is `readonly` on
Cloudflare's own `ExecutionContext` type and is never populated for a plain Access-fronted Worker
in the first place (it is a `@cloudflare/workers-oauth-provider`-specific convention this demo does
not use — Managed OAuth resolves a client's bearer token into a `Cf-Access-Jwt-Assertion` header
*before* the request reaches the Worker, never into `ctx.props`). Neither mechanism can safely
carry this demo's already-verified `Cloudflare_Access_Identity` (Hono context) into a module-scope
handler instance. **Decision**: build `createMcpHandler(() => createServer({ ownerEmail, ... }))`
fresh inside the `/mcp` route handler, once per request, closing over that request's own resolved
identity — correct for this demo's Access-native (not OAuth-provider-fronted) architecture, not a
shortcut. Phases 13/14's additional tool registrations should extend the same `createServer()`
factory rather than introduce a second identity-plumbing mechanism.

**2. `agents/mcp/server` requires the `nodejs_compat` compatibility flag.** `createMcpHandler`
imports `AsyncLocalStorage` from `node:async_hooks` at module scope (to track its own internal
per-request auth-context storage, unrelated to and unused by this demo's own identity wiring
above). `vite build` flags this plainly ("Unexpected Node.js imports... node:async_hooks... Do you
need to enable the nodejs_compat compatibility flag?") even though the locally available
`workerd`/Miniflare release this repository's pinned Wrangler bundles happened to tolerate the
import without the flag during `@cloudflare/vitest-pool-workers` integration tests — that
tolerance is not something to rely on for a real deployment. Added `"nodejs_compat"` to
`demos/architect/wrangler.jsonc.tpl`'s `compatibility_flags`, satisfying AGENTS.md's "Enable
`nodejs_compat` only when application dependencies require Node APIs" now that one genuinely does.

## NEW DECISIONS

## 31. Reusing an Access-gated banner on a public page: make the identity requirement an explicit
prop, and treat a failed identity request as "anonymous" rather than as an error

`demos/architect`'s Bug 34 (GitLab issue #2) asked for the regular application banner to be shown
on `/blueprints`, which had grown its own ad-hoc header. The obstacle is not layout, it is
identity: the banner exists to display the Cloudflare Access identity and offer a sign-out
control, and it gets that identity from `GET /api/me` — an endpoint that requires Access. But
`/blueprints` is deliberately public (covered by the hostname-wide `bypass` Access application),
so a visitor there may legitimately be anonymous, and lifting the banner across verbatim would
have shown them a `role="alert"` identity error and a "Sign out" link for a session they never
had.

**Decision.** The shared header component takes an explicit `access: "authenticated" | "public"`
prop rather than inferring anything from the current path or silently tolerating failures
everywhere:

- On `authenticated` pages (the Access-gated subtree), behaviour is unchanged and strict: the
  loading state is shown, a failed `/api/me` is surfaced as a `role="alert"` error because it
  genuinely indicates a fault, and the sign-out control is rendered unconditionally per AGENTS.md's
  Public Access section.
- On `public` pages, *any* `/api/me` failure — 401, 403, network, or 502 alike — simply means "not
  signed in". No status-code plumbing was added to the identity hook: on a page anonymous visitors
  are expected to reach, there is no useful distinction between "you are not signed in" and "we
  could not tell whether you are signed in", and surfacing either as an alert is noise. The
  identity slot renders nothing, and the auth action becomes "Sign in".
- The `public` auth action also renders *nothing* while the request is in flight, rather than
  defaulting to one control and flipping to the other on resolution. The authenticated subtree
  cannot do this (its sign-out control must be unconditional), but a public page has no such
  requirement, and a visible "Sign in" → "Sign out" flicker on every load is worse than a briefly
  empty slot.

**Two related points worth carrying to other demos.** First, the shared header takes the resolved
identity as a *prop* rather than calling the identity hook itself. The authenticated shell already
needed `isAdmin` to gate its admin route, so a hook call inside the header would have issued a
second, redundant `GET /api/me` on every admin render; passing it down keeps one request per page
and leaves the header purely presentational and testable without stubbing `fetch`. Second, the
brand link is identity-aware — it points at the authenticated landing route normally, but at the
public home page for an anonymous visitor on a public page. A logo that bounces an anonymous
visitor into an Access login they did not ask for is a worse default than one that varies.

**On the underlines that prompted the issue.** The endemic cause was that the stylesheet had no
global `a` rule at all, so every anchor kept the browser's default underline and link colour
unless a class explicitly opted out — which exactly one class did. The fix was a shared
`.nav-link` opt-out for application *chrome* links plus converting a mis-styled call to action to
`.button`, **not** a global `a { text-decoration: none }` reset. A global reset would have
stripped the underline from links inside running prose too, leaving them indistinguishable from
the surrounding text and failing WCAG 1.4.1 (Use of Color). `.nav-link` also restores the
underline on `:hover`/`:focus-visible`, so the affordance is demoted rather than deleted.

## NEW DECISIONS

## 32. `docs/09C-COLLABORATIVE-EDITING.md` Phase 16 spike findings — both load-bearing Durable
    Object platform behaviors confirmed, write-chain concurrency design proven by execution
    (`spikes/08-architect-collab-race`)

Three items from `docs/09C-COLLABORATIVE-EDITING.md`'s Phase 16 spike, re-verified against current
Cloudflare documentation and (for items 2 and 3) executed against a real local `workerd` instance.
Full detail, citations, and code in `spikes/08-architect-collab-race/REPORT.md`; summary here per
the Spike Conventions.

**1. Both platform behaviors "Why D1 Stays The Only Copy" depends on are confirmed, no
correction.** (a) A Durable Object's in-memory (class field) state is discarded on
hibernation/eviction — confirmed independently across four current pages:
[Durable Object Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
("When hibernated, the in-memory state is discarded"),
[WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
("In-memory state is reset" during hibernation),
[In-memory state in a Durable Object](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
("in-memory state is not preserved across eviction or hibernation"), and
[Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
which adds a detail worth carrying into Phase 18: in-memory state is *also* discarded "if it
crashes from an uncaught exception," not only on an idle-timeout eviction — meaning an
unanticipated `graph-mutations.ts` failure mode inside `applyOperation()`'s mutation step (today,
only `notFound()` is caught) would discard `this.graph` the same way hibernation does. Harmless for
data durability (D1 is unaffected either way) but worth catching broadly in Phase 18's
implementation to avoid an avoidable cold start for every other connected client. (b) Synchronous
JavaScript execution with no `await` between two statements cannot be interleaved by an incoming
event — confirmed against the same current Rules of Durable Objects guide's "input gates" section
("Input gates block new events... while synchronous JavaScript execution is in progress") and its
"all synchronous JavaScript execution is single-threaded" statement, corroborated by
[What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)'s
Actor-model framing and Cloudflare's own
["Easy, Fast, Correct — Choose three"](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
blog post. Neither behavior needed any correction to
`docs/09C-COLLABORATIVE-EDITING.md`'s existing description.

**2. The race, prototyped directly: exactly one deterministic winner, neither operation dropped —
confirmed by execution.** A small standalone Durable Object
(`spikes/08-architect-collab-race/src/diagram-session.ts`'s `TestDiagramSession`) built to mirror
the real, not-yet-implemented `DiagramSession.applyOperation()` write path's shape (`this.graph`,
`this.writeChain`) closely enough to exercise the same guarantees. Two RPC calls dispatched without
an `await` between them, both targeting the same node id, across five consecutive real
`@cloudflare/vitest-pool-workers` test runs (no flakes): a synchronous sequence counter incremented
inside each call's mutation step always produced two distinct values (never a duplicate — proof
the two mutations never interleaved with each other), both operations' values were always recorded
as genuinely applied (neither silently dropped), and the final in-memory graph and "persisted" D1
stub always matched whichever operation's mutation actually ran last by that sequence number —
regardless of which operation's own `Promise` happened to resolve first. A second test confirmed
two operations on different node ids never interact at all, matching the Concurrency Model
section's stated behavior for that case too.

**3. A slow write cannot land after and clobber a faster, later-enqueued write — confirmed by
execution, including a deliberate counter-example proving the test has real discriminating
power.** The identical adversarial scenario (a first operation's simulated persist artificially
delayed 30–50ms, a second, conflicting operation's not delayed at all) was run through two write
paths on the same test Durable Object: a naive, unchained path (each call captures its own
snapshot and persists it independently, no shared ordering) **does** reproduce the exact clobber
bug — the slow first write's stale snapshot lands in the "D1" stub *after* the fast second write's
correct value already did, confirmed via a dedicated counter-example test — while the real
write-chain design (a single per-object `this.writeChain` every persist joins, where each link
re-reads `this.graph` at the moment it actually runs rather than a value captured when it was
enqueued) never exhibits it, including in a polling test sampling the "persisted" stub every 4ms
throughout the delay window to confirm there is no even-transient stale-value window. **Decision:
no correction to `docs/09C-COLLABORATIVE-EDITING.md`'s write-chain design** — both strict
per-object ordering and always-fresh reads are confirmed necessary together (the counter-example
has neither and fails; the real design has both and does not) and sufficient to prevent an older,
slower write from ever clobbering a newer one, with no platform-level storage-ordering guarantee
from D1 required. Phase 17 and Phase 18 can proceed against the design exactly as written.

## NEW DECISIONS

## 33. `docs/09C-COLLABORATIVE-EDITING.md` Phase 18 implementation findings — `ctx.id.name`
    confirmed working with no fallback needed, and which layer actually converts a stale-target
    error into `operation_rejected`

Two items from implementing Phase 18
(`demos/architect/src/worker/diagram-session/diagram-session.ts`), recorded per Decision B's own
instruction to log a correction here if `ctx.id.name` turned out not to work, and to note one other
reconciliation worth keeping straight for future reference.

**1. `ctx.id.name` works exactly as documented in this repo's pinned Wrangler (`4.120.1`) runtime —
no correction, no fallback needed.** `docs/09C-COLLABORATIVE-EDITING.md`'s Decision B named the
March 2026 changelog entry,
["Access Durable Object name via `ctx.id.name`"](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/),
as the basis for `DiagramSession` reading its own diagram id from `this.ctx.id.name` rather than
threading an explicit `diagramId` parameter through every RPC method. Per that same decision's own
instruction to write a real integration test confirming this *before* relying on it,
`tests/integration/diagram-session.test.ts`'s `"ctx.id.name resolves to the diagram id for a
getByName()-obtained stub (Decision B sanity check)"` test asserts `state.id.name` equals the
diagram id used to obtain the stub via `env.DIAGRAM_SESSIONS.getByName(diagramId)`, and passes.
**Decision: no correction to the design — `ctx.id.name` is the diagram id source of truth for
`DiagramSession`, and the mechanical `diagramId`-parameter fallback Decision B described as a
correction path was never needed.**

**2. `applyOperation()` stays a single, honest, throwing RPC primitive; `webSocketMessage()` is the
one layer that converts a stale-target error into a non-throwing `operation_rejected` frame.**
`docs/09C-COLLABORATIVE-EDITING.md`'s own prose ("`applyOperation()` catches that specific error and
responds with `operation_rejected`...") reads as slightly loose about which layer actually performs
that catch, since the document also requires a direct RPC/MCP caller to receive a normal thrown
`notFound()` (matching every other MCP tool's existing behavior) rather than a swallowed error.
Implemented as: `DiagramSession.applyOperation()` never catches anything itself — a stale-target
`notFound()` thrown by `../../graph-mutations.ts`'s `applyGraphOperation()` propagates unchanged to
whichever caller invoked it (a direct RPC call from an MCP tool, or `webSocketMessage()`'s own call).
`webSocketMessage()` is the one place that wraps its call to `applyOperation()` in a `try`/`catch`,
turning that same error into `{ type: "operation_rejected", clientOpId, reason }` sent only to the
originating connection — never rethrown, never closing the socket. This keeps `applyOperation()`
identical for both callers the RPC Surface section names while still satisfying the Concurrency
Model's "never disconnects the socket" requirement — worth recording since a future reader wiring
another WebSocket-message-driven RPC call might otherwise put the `try`/`catch` in the wrong layer.

## NEW DECISIONS

## 34. `docs/09C-COLLABORATIVE-EDITING.md` Phase 20 verification findings — the two
    `ensureHydrated()` coverage gaps confirmed still not practically closeable in this pool;
    `dangerouslyIgnoreUnhandledErrors` identified and rejected as a fix

Phase 18's implementer (`docs/DECISIONS.md` #33's neighboring code comment in
`tests/integration/diagram-session.test.ts`) left `ensureHydrated()`'s two `throw new Error(...)`
branches (an unnamed `ctx.id.name`, and a diagram deleted out from under an already-authorized
request) deliberately uncovered, because triggering a `blockConcurrencyWhile()` callback throw in
this Vitest pool marks the whole Durable Object instance "broken" in a way that flips the
*overall* `vitest run` process exit code to `1` even though every individual assertion still
passes. Phase 20 re-attempted this properly before accepting it as permanent, per this document's
own instruction to research a documented way around it.

**Three concrete approaches tried, all still exit `1`:** a scratch test file
(`tests/integration/_scratch-hydrate.test.ts`, deleted after this investigation — not part of the
final change set) exercised (a) a direct RPC call with a plain `try`/`catch`, (b) a direct RPC
call asserted with `.rejects.toThrow()`, and (c) the same missing-diagram-from-D1 branch through
`runInDurableObject()` with `.rejects.toThrow()`. Every one of the three tests' own assertions
passed in isolation, but each one still produced Miniflare's own `"Annotating with brokenness"`
diagnostic and a separate, unhandled top-level rejection (`Serialized Error: { durableObjectReset:
true }`) that Vitest reports independently of the awaited promise the test code actually catches —
confirming `runInDurableObject`'s own error-catching semantics behave no differently than a direct
RPC call's here, and that `.rejects.toThrow()` does not avoid the problem either. Running only
this scratch file in isolation (`vitest run --project integration -t scratch`) still exited `1`
despite "3 passed" test-level output, and running the *entire* `integration` project with the
scratch file included also exited `1` while still reporting every one of 104 tests (including this
file's own) as passed — confirming Vitest's unhandled-error tracking is a property of the whole
run, not scoped per test file, so isolating the offending test into its own file does not help the
overall exit code the way it might help *other* files' results stay legible.

**A fourth option exists — `test.dangerouslyIgnoreUnhandledErrors` — but is rejected as too broad
a fix for two lines.** Vitest 4 has a real config flag for exactly this class of problem
(`node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js`: `if (errors.length &&
!this.config.dangerouslyIgnoreUnhandledErrors) process.exitCode = 1;`). Checking its type
(`RuntimeConfig` in `vitest/dist/chunks/config.d.A1h_Y6Jt.d.ts`) confirms it is **not** one of the
options `vi.setConfig()`'s `RuntimeOptions` can toggle per-test or per-describe-block at runtime —
it is settable only in `tests/integration/vitest.config.ts`'s own `test` block, for the entire
`integration` project. Setting it there would silence *every* unhandled error for all ~100
integration tests in this project, not just the two lines this gap is about — a real, permanent
weakening of this project's ability to catch a genuine future regression (an accidentally
unawaited promise, an actually-broken Durable Object from an unrelated code change) anywhere else
in that same project, for the sake of two lines that are already real, correct, and independently
readable guards. **Decision: leave both `ensureHydrated()` throw branches uncovered, matching
Phase 18's original call, and do not set `dangerouslyIgnoreUnhandledErrors`.** No source change was
made to `ensureHydrated()` itself (both branches remain unchanged, real, honest guards) and no
project-wide Vitest config change was made. This is the one open coverage gap in
`docs/09C-COLLABORATIVE-EDITING.md`'s own scope; the second, pre-existing gap
(`src/client/lib/datetime.ts:82`) predates this document's work and remains explicitly out of
scope for it.

## NEW DECISIONS

## 35. `docs/09D-ARCHITECT-AICHAT.md` Phase 21 spike findings — confirmed `AI_CHAT_MODEL`, MCP
    docs-client package, and `DiagramSession` disconnect resilience

The four numbered items from `docs/09D-ARCHITECT-AICHAT.md`'s Phase 21 spike, each re-verified
against current sources rather than taken from this repository's own prior descriptions. No local
`.env`/API token exists in this worktree, so no real `env.AI.run()` call could be made; item 1's
finding is therefore documentary, not empirical, and is flagged as such below.

**1. `AI_CHAT_MODEL`: keep `@cf/zai-org/glm-5.2` as the default; `@cf/moonshotai/kimi-k2.6` is the
confirmed current fallback id.** Both model pages were fetched live from
[developers.cloudflare.com](https://developers.cloudflare.com/workers-ai/models/) on 2026-08-11.
[`glm-5.2`](https://developers.cloudflare.com/workers-ai/models/glm-5.2/) (`@cf/zai-org/glm-5.2`,
exact id unchanged from the document's draft) lists **Function calling: Yes** and Reasoning: Yes, a
262,144-token context window, and "Paid access required." Moonshot AI's current catalog id —
the document's own `@cf/moonshotai/kimi-...` placeholder — resolves to
[`@cf/moonshotai/kimi-k2.6`](https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/)
(confirmed via both a direct page fetch and a `search_cloudflare_documentation` call against
`https://docs.mcp.cloudflare.com/mcp` for "kimi-k2.6 model function calling Workers AI," which
returned that exact URL as the top-ranked result), also listing **Function calling: Yes**,
Reasoning: Yes, Vision: Yes, a 262,144-token context window, and "Paid access required." A
`GET .../changelog/post/2026-05-21-rest-api/` result surfaced by the same docs search independently
names `@cf/moonshotai/kimi-k2.6` as a worked example of an AI Gateway REST call, corroborating the
id from a second page. Neither this repository nor this sandbox has a Cloudflare API token
available, so **no live `env.AI.run()` call against a plain (non-dynamic-route) gateway binding
could be made for either model** — this finding rests on current model-catalog metadata (the
"Function calling: Yes" flag on both models' own pages) plus `docs/DECISIONS.md` #13's own
already-proven result that `@cf/zai-org/glm-5.2` returns well-formed `tool_calls` when called
through this account's AI Gateway (there, via a **dynamic route**, not a plain gateway — #13 also
found the *same* dynamic-routing call mechanism rejects several other otherwise-function-calling-
capable models with `AiGatewayError 2002`, so "documented function-calling support" alone is not
sufficient evidence a given model works through *any* gateway shape). **Decision: default
`AI_CHAT_MODEL` to `@cf/zai-org/glm-5.2`** (already this repository's one demonstrated
gateway-routed tool-calling success, and already used successfully — directly, non-gateway and
via `demos/agentic-ai-chat`'s dynamic route — elsewhere in this repo), **with `@cf/moonshotai/kimi-
k2.6` as the named fallback** to try if Phase 23's real integration test finds `glm-5.2` does not
return well-formed `tool_calls` through 09D's specific plain-gateway binding shape. This residual
uncertainty (plain-gateway vs. dynamic-route tool-calling behavior is not the same thing, per #13's
own model-by-model sweep, and has not been empirically re-tested for either candidate against a
plain gateway) is explicitly Phase 23's own integration test's job to close before Phase 24 begins,
not something this spike can settle from documentation alone.

**2. `@modelcontextprotocol/client@2.0.0`'s exports are confirmed, and a live, unauthenticated call
to the public docs MCP server succeeded end to end.** `npm view @modelcontextprotocol/client@2.0.0`
confirms `2.0.0` (not a prerelease) is the current published version, matching
`demos/architect/package.json`'s pinned `devDependencies` entry. Unpacking the real published
tarball (`npm pack`) and grepping its `dist/index.d.cts` confirms both `Client` (`declare class
Client extends Protocol<ClientContext>`) and `StreamableHTTPClientTransport` (`declare class
StreamableHTTPClientTransport implements Transport`) are exported from the package's top-level
`export { ... }` statement — exactly the two symbols `docs/09B-ARCHITECT-MCP.md`'s own References
section and `docs/09D-ARCHITECT-AICHAT.md`'s Cloudflare Docs Tool section both name. This sandbox
has real outbound network access: a raw `curl -X POST https://docs.mcp.cloudflare.com/mcp` with an
`initialize` JSON-RPC body returned `HTTP/2 200` and a real `initialize` result (`serverInfo:
{"name":"docs-ai-search","version":"0.4.13"}`, `protocolVersion: "2025-06-18"`) with **no
`Authorization` header and no session negotiation** — matching the document's "requires no OAuth or
API token" claim. A second raw `curl` call, `tools/call` for `search_cloudflare_documentation` with
`{"query": "Workers AI function calling"}`, and sent with **no prior `initialize` call on the same
connection at all** (this server accepts a bare `tools/call` — it does not enforce session
continuity across HTTP requests, consistent with 09D's own "a fresh server per request, by its own
README" description), returned a real `200` with five ranked `{url, title, text}` results including
the exact current `/workers-ai/features/function-calling/` guide. This is real evidence for both
halves of item 2 at once: the SDK exports `docs-client.ts` needs are real and stable, and the
target server itself is reachable, unauthenticated, and returns well-formed tool results, from
this same class of sandboxed environment `DiagramSession` runs in. **Decision: no correction to the
document's package or client design.** `package.json` itself is intentionally left unchanged in
this phase (Phase 21 is research-only) — Phase 22 or 23's implementer must move
`@modelcontextprotocol/client` from `devDependencies` into `dependencies` (it is a real runtime
import for `src/worker/ai/docs-client.ts`, not merely a test-time tool as it is for 9B), per the
document's own Infrastructure Changes section.

**3. Async work started inside a Durable Object's WebSocket message handler is confirmed to keep
running after the originating client disconnects, and current Durable Objects documentation
supports this without qualification.** [Lifecycle of a Durable
Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)'s
hibernation-eligibility list states hibernation can only occur if, among other conditions, **"No
request/event is still being processed, because hibernating would mean losing track of the async
function which is eventually supposed to return a response to that request."** This is the load-
bearing sentence for this finding: a `webSocketMessage()` invocation's own returned `Promise` (the
multi-round `runDiagramChatTurn()` loop this document runs inside it) is exactly this kind of
"still being processed" event, and the object stays in the **active, in-memory** state — not
hibernated, not evicted — for as long as that promise has not yet resolved, independent of whether
the specific WebSocket connection that delivered the triggering message is still open. Nothing in
the runtime's WebSocket model cancels or aborts an already-running async call chain when the
client-side socket closes: [Use
WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)'s own
`webSocketClose()` handler is a separate, additional event delivered to the object (used here only
to clean up presence state), not a signal that unwinds or interrupts whatever async work a prior
`webSocketMessage()` call already started — JavaScript execution inside one Durable Object instance
is single-threaded and cooperative, so a close event cannot preempt an in-flight `await` chain any
more than a second concurrent `operation` message could (the same "no interleaving" guarantee
`docs/DECISIONS.md` #32 already confirmed generically). Once that turn's loop finishes and calls
`this.applyOperation()`, the mutation is written to D1 through the object's own existing write
chain — durable regardless of which, if any, connections are still attached. A reconnecting client
obtaining a stub for the same diagram id (`env.DIAGRAM_SESSIONS.getByName(diagramId)`, matching
`docs/DECISIONS.md` #33's confirmed `ctx.id.name` identity mechanism) opens a fresh
`fetch()`/`acceptWebSocket()` call, which per 9C's own already-implemented `fetch()` handler sends a
`graph_snapshot` built from `this.graph` (or, if the object was actually evicted between the turn
finishing and the reconnect, from a fresh `blockConcurrencyWhile()` hydration off D1 — either path
reflects the turn's result, since it was already durably persisted). **Decision: no correction to
`docs/09D-ARCHITECT-AICHAT.md`'s "Why This Runs Inside `DiagramSession`" design — the specific
disconnect-resilience behavior it depends on is confirmed by current Durable Objects documentation,
and Phase 23's own disconnect-mid-turn integration test (already specified in the document's Phase
23 section) is the right place to prove it empirically against the real `DiagramSession`, not a
design change.**

**4. Every field named in the document's `cloudflare_ai_gateway` HCL block exists in the pinned
`cloudflare/cloudflare ~> 5.22.0` provider's real schema, with one useful refinement to the
document's own "optional-but-not-computed" framing.** `terraform -chdir=demos/architect/infra init
-backend=false` (read-only; downloads the provider plugin only, makes no Cloudflare API call and
touches no state) followed by `terraform providers schema -json` confirms, against this exact
pinned version: `authentication`, `logpush`, `log_management`, `log_management_strategy`, and `zdr`
are all `optional`, **not** `computed` — the precise schema shape #13 already found necessitates
pinning them explicitly, or the API's own server-filled defaults cause perpetual `plan` drift.
`cache_invalidate_on_update`, `cache_ttl`, `collect_logs`, `rate_limiting_interval`, and
`rate_limiting_limit` are actually **`required`** in this version's schema, not "optional-but-not-
computed" as the document's prose (copied from #13's spike-era account of the same fields)
describes — a `terraform plan` fails outright with "argument is required" if any of these five is
omitted, a different (louder, earlier) failure mode than silent drift, though the practical
consequence for this document's own HCL is identical: every one of these five is already set
explicitly in the quoted block, so no HCL change is needed either way. `spend_limits` is a
single-nested object attribute (`optional`, `computed`) whose own `rules` list attribute nests
`limit_type` (`required`, enum `"cost"`), `limit` (`required`, `number`), and `window` (`required`,
`number`) — exactly the three fields the document's `spend_limits.rules[]` block sets, and
`spend_limits.enabled` itself is `optional`/`computed` but is also already set explicitly
(`enabled = true`) in the document's HCL. `terraform -chdir=demos/architect/infra validate` and
`terraform fmt -check -diff` both pass cleanly against the current, unmodified `infra/` directory
after this same `init`, confirming this inspection made no changes of its own. **Decision: no
change needed to the document's quoted `cloudflare_ai_gateway` HCL block** — every field it names
is present, and the block already pins every field this schema dump shows is either `required` or
`optional`-but-`not`-`computed`; Phase 23's implementer should simply copy the block as written,
noting only that a field being merely `required` (a hard `plan`-time error if forgotten) rather than
"silently drifting" is a strictly easier failure mode to catch than what #13 originally described
for the other class of field.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this
heading when they have been incorporated.

## 36. `docs/09D-ARCHITECT-AICHAT.md` Phase 23 implementation findings — bare-`console` logging
    inside a Durable Object, and `env.AI` cannot be stubbed for a real `DiagramSession` in this
    integration test pool

Two findings from wiring `DiagramSession.handleChatMessage()` (`demos/architect/src/worker/
diagram-session/diagram-session.ts`) to `src/worker/ai/chat-engine.ts`'s `runDiagramChatTurn()`.

**Plain `console.log()`/`console.error()`, JSON-stringified per call, is this repository's own
narrow, deliberate precedent for structured logging inside a bare Durable Object with no Hono
`Context` available.** `cloudflareLogger()` (this repo's usual logging mechanism, decision #5)
resolves a request-scoped `Logger` onto a Hono `Context` at middleware time — `DiagramSession`
has no Hono `Context` at all, and neither 9B nor 9C ever needed one, since neither introduced any
logging inside this object. `demos/agentic-ai-chat`'s `ChatAgent` (an Agent/Durable Object outside
a Hono context) already falls back to plain `console.error(...)` for exactly this reason, and this
phase followed that same precedent for its three new structured events
(`ai_chat_turn_completed`/`ai_chat_turn_failed`/`ai_docs_lookup_performed`), one
`console.log`/`console.error` call per event, each argument a single `JSON.stringify()`-encoded
object so Workers Logs can still parse it as structured data without the toolkit's own logger
involved. A future Durable-Object-based demo needing logging inside the object itself (not just
inside the Hono routes that call it) should reuse this same pattern rather than inventing a new
one or trying to thread a `cloudflareLogger()`-produced `Logger` instance into a Durable Object
across an RPC/WebSocket boundary.

**`env.AI` cannot be substituted with a fixture for a real Durable Object instance in
`@cloudflare/vitest-pool-workers`, and this is a hard platform limitation, not a missing test
trick.** Investigated per this phase's own instructions before accepting this: (1) Miniflare's own
`AIOptionsSchema` (`node_modules/miniflare/dist/src/index.d.ts`) has exactly two fields,
`binding`/`remoteProxyConnectionString` — no fake/local-execution mode exists for this plugin at
all, confirming decisions #9/#11's "Workers AI has no local simulation" finding extends to every
known override mechanism, not just the ones those decisions already tried. (2) `demos/ai-chat`'s
own `{ ...env, AI: fakeAi }` substitution trick (its `tests/integration/fixtures.ts`) works only
because its integration tests call the Hono app's own `app.fetch(request, env, ctx)` directly with
a test-constructed `env` object — it cannot reach a **Durable Object**'s own `this.env.AI`
regardless, since a Durable Object's bindings are resolved by the Workers runtime from
`wrangler.jsonc`'s own binding configuration at construction time, never from whatever `env` object
happened to be in scope at the call site that reached it via `getByName()`/RPC. (3) A live scratch
test (`env.AI.run(...)` called directly, `remoteBindings: false`) confirmed the failure mode is a
clean, synchronous, catchable throw (`Error: Binding AI needs to be run remotely`) on every call,
every time — not a hang, not a silently wrong result — which is what makes this phase's
error-path integration test (`chat_message` → `chat_error`, never crashing the connection) both
safe to write and a faithful stand-in for a genuine AI Gateway/binding-level failure in production.
**Decision: `tests/integration/vitest.config.ts` sets `remoteBindings: false` (matching
`demos/ai-chat`'s own precedent) so the whole integration suite stays runnable with zero
Cloudflare credentials; `DiagramSession.handleChatMessage()`'s success path (the tool-calling loop
actually running, `chat_status`/`chat_token`/`chat_done`/`operation_applied` with `origin:
"ai-chat"` actually being sent) is exhaustively covered instead against a fixture Workers AI double
in `src/worker/ai/chat-engine.test.ts`, which needs no Durable Object at all — and is accepted as
an uncovered integration-test/coverage gap in `diagram-session.ts` itself, the same category of
accepted, documented gap decision #34 already established for `ensureHydrated()`'s two throw
branches, for the same underlying reason: this pool cannot exercise it any other way. Revisit if
Miniflare ever ships a local/fake execution mode for the `ai` binding, or if a future
`@cloudflare/vitest-pool-workers` release exposes some other way to override a Durable Object's own
bound `env` per test.

## NEW DECISIONS

New decisions will be located below here before they are incorporated, and moved above this
heading when they have been incorporated.

## 37. `docs/09D-ARCHITECT-AICHAT.md` Phase 26 verification findings — a real Durable Object
    instance's own `env` property *can* be overridden per test, closing most of decision #36's
    accepted gap; the one genuinely-uncoverable slice that remains, and the final coverage/
    accessibility/web-perf state

Phase 26 re-investigated decision #36's second finding ("`env.AI` cannot be substituted with a
fixture for a real `DiagramSession` in this integration test pool") before accepting it
permanently, per this repository's own instruction to research a documented way around a gap
before leaving it. Decision #36 is still correct about the specific mechanism it tested (a
call-site `env` substitution, the way `demos/ai-chat`'s `fixtures.ts` does when it calls
`app.fetch(request, env, ctx)` directly, cannot reach a Durable Object's own bound `env` — a
Durable Object's bindings are resolved by the Workers runtime at construction time, not from
whatever `env` object happened to be in scope at the call site that reached it). **But a
different, working seam exists: `runInDurableObject()` hands back the real, live class instance,
not a copy, and `this.env` is an ordinary, mutable JS property on that instance — set once by the
`DurableObject` base class's own constructor — not a runtime-enforced read-only binding site.**
A scratch test (`tests/integration/_scratch-ai-override.test.ts`, deleted after this
investigation) confirmed that `runInDurableObject(stub, (instance) => { instance.env.AI = { run:
async () => fakeResult }; })` really does let a subsequent call reach the fixture, not the real
Miniflare `AI` proxy that throws `Error: Binding AI needs to be run remotely`. Because
`getByName()` returns a stub for the *same* live, in-memory object a socket opened earlier via the
Worker's own route is already attached to (confirmed by several pre-existing tests in this same
file already calling `env.DIAGRAM_SESSIONS.getByName(diagramId).getSnapshot()` against a
socket already open on that id), reassigning `instance.env` once, right after opening a live
socket, and before sending a `chat_message` frame to it, reaches `handleChatMessage()`'s real
`this.env.AI` call for that entire test.

**Decision: use this technique to add real, end-to-end `DiagramSession` integration tests for the
AI chat success path**, in a new `tests/integration/diagram-session.test.ts` describe block ("AI
chat (Phase 26) — full turn against a fixture Workers AI double"), alongside (not replacing)
Phase 23's own two error-path tests and `src/worker/ai/chat-engine.test.ts`'s existing exhaustive
unit coverage of the loop itself. Two new tests: one drives a fixture Workers AI double through
one `add_node` tool call, one `rename_diagram` tool call, and a streamed final answer, asserting
`chat_status`/`operation_applied` (`origin: "ai-chat"`)/`diagram_renamed`/`chat_token`/`chat_done`
all arrive correctly on the originating connection, and that a second, non-originating connection
also receives the `operation_applied`/`diagram_renamed` broadcasts without having sent anything
itself (the specific claim docs/09D-ARCHITECT-AICHAT.md's Message Protocol section makes about a
bystander seeing the assistant's edits live); the other drives a rejected `update_node` tool call
(a nonexistent `nodeId`) and confirms the turn still completes normally (`chat_done`, not
`chat_error`) with the rejection reason fed back as the model's tool result, and that no
`operation_applied` broadcast fires for it. Together these close every previously-uncovered line
in `handleChatMessage()`'s success path except one.

**The one line decision #36's gap still correctly describes as unclosable: the
`search_cloudflare_documentation` tool's own `onDocsLookup` closure.** Reaching it requires the
fixture model to actually call that tool, which runs `../ai/docs-client.ts`'s real
`Client`/`StreamableHTTPClientTransport` against the literal, hardcoded
`https://docs.mcp.cloudflare.com/mcp` URL — a genuine outbound network call with no injection seam
of its own (unlike `env.AI`, there is no bound object to reassign; the URL is a plain module
constant, and `vi.mock()` cannot reach code executing inside
`@cloudflare/vitest-pool-workers`'s own workerd isolate the way it reaches a plain unit test's
top-level imports in `src/worker/ai/chat-engine.test.ts`). Forcing that call from this project's
integration suite would need real network access on every `test`/`test:coverage` run, exactly the
dependency `remoteBindings: false` (decision #9) already exists to avoid for the `AI` binding
itself — and this sandbox having real network access (decision #35) does not mean every future
environment this suite runs in will. This one closure's own body is trivial, branch-free
pass-through with no logic of its own worth that dependency to reach; `chat-engine.test.ts`
already covers `executeToolCall()`'s `search_cloudflare_documentation` dispatch (both the `ok`
and failure outcomes) against a mocked `searchCloudflareDocumentationSafe`, and
`docs-client.test.ts` already covers the real parsing/timeout/failure logic this closure merely
relays. **Decision: leave this one closure uncovered, documented with an inline code comment at
its own definition** (`src/worker/diagram-session/diagram-session.ts`), matching decision #34's
own rigor and its own explicit allowance for "one or two similarly genuinely-uncoverable
defensive branches."

**Final coverage state for `demos/architect`, confirmed by a full `npm run test:coverage` run
after every fix in this phase**: 99.78% statements / 99.37% branches / 99.85% functions / 99.84%
lines, with exactly three uncovered lines remaining across the entire project, all pre-existing or
newly-justified exceptions, none newly introduced: `src/client/lib/datetime.ts:82` (pre-existing,
out of this document's scope entirely, decision #34); `src/worker/diagram-session/
diagram-session.ts:274,283` (`ensureHydrated()`'s two `throw new Error(...)` branches,
pre-existing, decision #34); `diagram-session.ts`'s own `onDocsLookup` closure body (this decision,
above). One additional, closable gap found and fixed in this same phase but not AI-chat-specific:
`src/client/hooks/useDiagramLiveSync.ts`'s `chat_token` accumulator's `.map()` had never been
exercised with more than one existing transcript entry, so the branch that leaves a non-active
entry (a preceding `kind: "user"` entry, in practice) unchanged had zero hits; a new test sends
the user's own message first (via `sendChatMessage()`, which prepends that entry) before two
`chat_token` frames, closing it.

**Accessibility (Part 3) and web-perf (Part 4) findings.** A manual WCAG 2.2 AA read of
`DetailsPanel.tsx`, `AiChatPanel.tsx`, `GenerateWithAiModal.tsx`, the toolbar's "AI Assistant"
button, and `BlueprintGallery.tsx`'s "Generate with AI" tile found the tab pattern (matching IDs
between `aria-controls`/the tabpanel's own `id`, and `aria-labelledby` tracking the active tab),
the `role="log"`/`aria-live="polite"` transcript (relying on the standard "one consolidating
region, not one region per token" mitigation — confirmed already true: only the transcript's own
container carries `aria-live`, and `chat_token` frames mutate one existing DOM node's text rather
than inserting a new announced node per token), every icon-only control's accessible name,
`useModalFocus()` wiring (matching `CreateDiagramModal.tsx`'s own usage exactly), and icon-button
target sizes (both new icon-only controls exceed this repository's existing 24×24px bar once
padding/border are accounted for, matching `.modal__close`/`.properties-panel__close`'s own
explicit `min-height`/`min-width: 24px`) all already met this repository's own existing bar with
no changes needed. **One genuine issue found and fixed**: `.ai-chat-panel__message--error` used a
new, non-theme-aware hardcoded `#dc2626` for both its border and text color, instead of reusing
`--cf-danger` (already vetted for contrast in both light and dark themes, and already the
established pattern for exactly this "error text/border on a surface" case —
`.toolbar__export-error` immediately above it in the same file already does this). Fixed by
substituting `var(--cf-danger)` for both properties; every other new CSS rule in this feature's
`.details-panel`/`.ai-chat-panel*`/`.blueprint-card--generate`/`.blueprint-card__preview--generate`
sections already reused an existing `--cf-*` custom property or the file's own separately
well-established `light-dark(#555, #aaa)` muted-text literal (used dozens of times elsewhere in
this same file, pre-existing this feature). `src/client/lib/auto-layout.ts` still has no
top-level `elkjs` import (confirmed by re-reading its own imports; the dynamic
`import("elkjs/lib/elk.bundled.js")` is still inside {@link computeAutoLayout}'s own function
body). `npm run build`'s chunk report confirms the `elk.bundled` chunk is byte-for-byte
unchanged (1,432.40 kB / 441.77 kB gzip, identical hash-suffixed filename length, before and
after this document's own Phases 22–25) — proof this feature added no new eager `elkjs` pull-in
of its own. A side-by-side build against Phase 23's own commit (before any of this document's UI
existed) versus the current tree found the client's main JS chunk grew from 583.52 kB (173.73 kB
gzip) to 607.32 kB (177.48 kB gzip), and its CSS grew from 35.54 kB (6.35 kB gzip) to 38.89 kB
(6.78 kB gzip) — roughly +24 kB raw / +3.75 kB gzip of JS and +3.35 kB raw / +0.43 kB gzip of CSS
for this document's entire new UI surface (`DetailsPanel.tsx`, `AiChatPanel.tsx`,
`GenerateWithAiModal.tsx`, the new toolbar button, the new gallery tile, and every new CSS rule
combined). Nothing surprisingly large.

## NEW DECISIONS

## 38. `@vitest/coverage-istanbul` cannot parse the Agents SDK's `@callable()` TC39 decorator —
    override `coverage.instrumenter` with an added Babel `parserPlugins` entry, don't avoid the
    decorator (`demos/review-agent`, docs/07-PR-REVIEW-AGENT.md Phase 4/5)

`ReviewRunAgent`'s `@callable() async start(...)` — this repository's first use of the Agents
SDK's `@callable()` decorator on a real `Agent` subclass — made `npm run test:coverage` throw a
hard `SyntaxError` ("Support for the experimental syntax 'decorators' isn't currently enabled")
the moment istanbul tried to instrument that file, even though every other check (`tsc --noEmit`,
`vite build`, and every non-coverage Vitest run) passed cleanly. This is not a project
misconfiguration: `@vitest/coverage-istanbul` bundles its own fixed Babel parser-plugin list
(`@istanbuljs/schema`'s defaults plus one `importAttributes` entry it adds itself), and that list
has no entry for either decorator proposal at all — legacy or current. This project's
`tsconfig.json` sets no `experimentalDecorators` flag, so `agents`'s `callable()` decorator is
written against the *current*, non-legacy TC39 proposal, which is a strictly different Babel
parser plugin (`"decorators"`, no `legacy: true`) from the one a `experimentalDecorators: true`
project would need (`"decorators-legacy"`).

**Fix confirmed working**: `@vitest/coverage-istanbul`'s provider reads an optional
`coverage.instrumenter` factory function from the Vitest config and, when present, uses it
*instead of* its own built-in `Instrumenter` construction — this is a real, if thinly documented,
extension point (confirmed by reading `node_modules/@vitest/coverage-istanbul/dist/provider.js`
directly), not a hack. `demos/review-agent/vitest.config.ts` adds `istanbul-lib-instrument` (the
same library version `@vitest/coverage-istanbul` itself depends on, `^6.0.3`) as a direct
devDependency and supplies its own `coverage.instrumenter` reproducing the provider's own default
options (`produceSourceMap`, `autoWrap: false`, `esModules: true`, `compact: false`,
`ignoreLines: true`) with `"decorators"` added to `parserPlugins`. This only widens what Babel is
willing to *parse* while re-emitting instrumented source for coverage counting — it does not
transform decorators away, and does not need to: the actual code that executes during a test run
always comes from Vite/esbuild's own separate transform, never from istanbul's Babel pass.

**Do not "fix" this by avoiding the decorator syntax** (for example, manually registering a
method into `agents`'s internal `callableMetadata` WeakMap the way `callable()`'s own decorator
body does) — that trades a real, idiomatic Agents SDK convention every future Agents SDK demo
will also reach for, for a workaround narrower than the actual problem. Fix the tooling once,
here, so a later demo using `@callable()` (or any other current-proposal method/class decorator)
does not rediscover the same `SyntaxError` from scratch.

**A trailing type-only wrinkle**: `@types/istanbul-lib-instrument` and `@types/babel__core` (both
added as devDependencies so `tsc --noEmit` can typecheck the new `vitest.config.ts` code) are
unmaintained community packages typed against the old `babel-generator`/`babel-types` scope, not
the real `@babel/*` scope the actual bundled v6.0.3 library uses — they are missing `ignoreLines`
on `InstrumenterOptions` entirely and type `generatorOpts` against an older `GeneratorOptions`
with no `importAttributesKeyword`. Cast narrowly around just the missing fields (or drop a
default-only field like `generatorOpts.importAttributesKeyword` entirely when nothing in the
project actually needs it, as this fix does) rather than casting the whole configuration object
and losing real type-checking on everything else in it.

## 39. `agents/vite`'s official plugin (not a hand-rolled Babel config) is required for
    `@callable()` to survive Vite's own dev/build pipeline, and needs one extra hoisted
    devDependency to actually resolve (`demos/review-agent`, docs/07-PR-REVIEW-AGENT.md Phase 6)

Decision #38 fixed `@vitest/coverage-istanbul` choking on `ReviewRunAgent`'s `@callable()`
decorator. A second, independent instance of the exact same root cause then broke `npm run
start`/`vite build` itself: the Cloudflare Vite plugin's own worker-entry export-type detection
(and Rolldown/esbuild's bundling) also cannot parse a bare, untransformed TC39 standard-decorators
class member — surfacing as an opaque `SyntaxError: Invalid or unexpected token` thrown deep
inside `@cloudflare/vite-plugin`'s `getWorkerEntryExportTypes`, with no mention of decorators at
all, that reproduced identically on a `git stash`-clean checkout (i.e., across the whole worker
bundle, not something introduced by unrelated code).

**Fix**: the `agents` package ships its own dedicated Vite plugin for exactly this, `agents/vite`
(confirmed by reading `node_modules/agents/dist/vite.d.ts`: "Handles TC39 decorator transforms
(Oxc doesn't support them yet, oxc#9170) so `@callable()` works at runtime"). Add `agents()` to
`vite.config.ts`'s `plugins` array, positioned before `cloudflare()` (the same "transform the
source before the Worker-bundling step sees it" ordering `vue()` already needs) — no options
needed for the default case. Do not attempt to configure `@babel/plugin-proposal-decorators`
directly in a project-level Babel config instead: `agents/vite` already wires the exact plugin
version (`^8.0.2`) and options its own runtime `callable()` semantics were built against, and
duplicating that configuration by hand risks drifting from it on `agents`'s next release.

**One real gotcha the plugin's own README does not mention**: `agents/vite` only *invokes*
`@babel/plugin-proposal-decorators`; it does not vendor it in a way Rolldown's Babel integration
can resolve. `@babel/plugin-proposal-decorators` was genuinely present on disk (nested at
`node_modules/agents/node_modules/@babel/plugin-proposal-decorators`, a legitimate transitive
dependency `agents` declares), but Babel's own `resolveStandardizedName`/`import-meta-resolve`
codepath resolves plugin names from a synthetic "virtual resolve base" file at the *project root*,
which cannot see into a dependency's own nested `node_modules` — a plain Node hoisting problem,
not anything `agents/vite` did wrong. The fix is to add `@babel/plugin-proposal-decorators` as a
**direct devDependency** of the demo itself (matching the exact version range `agents` itself
declares, `^8.0.2`) purely so npm hoists it to the project's own top-level `node_modules`, where
the virtual resolve base can find it. Nothing in the project's own source ever imports this
package directly — it exists solely to make `agents/vite`'s internal `require()` resolvable.

**A second, unrelated local-dev trap this same investigation surfaced**: editing an
*already-locally-migrated* D1 migration file in place (Phase 4 added `review_runs.full_report`/
`review_reviewers.raw_output` columns to `migrations/0001_create_review_tables.sql` after Phase 1
had already run `db:migrate:local` once against it) leaves the on-disk local D1 SQLite file
permanently missing those columns — Wrangler's migration tracking records a migration file as
already-applied by name and never re-diffs its contents, so `db:migrate:local` prints "No
migrations to apply!" and silently does nothing, and every later query against the missing column
throws `D1_ERROR: no such column: full_report` at runtime instead of at migration time. Local D1
state is disposable and gitignored (`.wrangler/state`), so the fix is simply to delete it
(`rm -rf .wrangler/state`) and re-run `db:migrate:local` after editing an already-applied local
migration during development — never edit a migration file that has already shipped to a real,
non-disposable database (production or a shared remote dev database); add a new migration file
instead, per ordinary migration discipline.

## NEW DECISIONS

## 40. `@cloudflare/vitest-pool-workers` never forwards istanbul's coverage counters out of a
    workerd isolate at all — the real fix is registering `agents/vite` a second time so tests can
    import the real Worker entry point, not a `coverage.exclude` (`demos/review-agent`,
    docs/07-PR-REVIEW-AGENT.md Phase 7)

Every integration test through Phase 6 (`tests/integration/webhooks.test.ts`, `reviews.test.ts`)
built a standalone Hono app mounting only one router directly, never importing
`src/worker/index.ts` itself — confirmed, by reading each file's own doc comment, to be a
deliberate workaround for a *different*, already-diagnosed problem (`agents`'s top-level module
unconditionally imports `cloudflare:workers`, which Node's plain ESM loader cannot resolve). That
workaround had a silent side effect nobody had yet traced to its root cause: `src/worker/index.ts`
itself, `src/worker/middleware/access.ts` (only ever loaded as part of `index.ts`'s own module
graph), `src/worker/agents/ReviewRunAgent.ts`, and `src/worker/workflows/ReviewPipelineWorkflow.ts`
all reported a flat **0%** in `npm run test:coverage`, even though `npm run test` passed cleanly
and every one of those four files is genuinely exercised — just never by any test file that
directly imports the module graph reaching them.

**Root cause, confirmed by direct experiment, not assumption.** `@cloudflare/vitest-pool-workers`
is a *custom* Vitest pool (its own `dist/pool/index.mjs`); unlike Vitest's built-in pools, nothing
in its own source (`dist/worker/index.mjs`, confirmed by `grep`) ever reads `globalThis.__coverage__`
out of the `workerd` isolate a test file runs in and forwards it back to the main Node process's
coverage reporter. Istanbul-instrumented code executed *inside* that isolate still increments its
own counters — they simply never leave the isolate. The pool's own error message when a project
configures the (unsupported) `v8` coverage provider — "Use Istanbul instead — it works by
instrumenting source code and runs on any JavaScript runtime" — is true only in the narrow sense
of "does not crash"; it is not a claim that coverage data collection/merging works for code
executed inside the isolate. This is confirmed empirically, not merely inferred: a file directly
`import`ed by a test file (`webhooks.test.ts`'s own `webhooksRouter` import, still executed inside
`workerd` because of the `cloudflare:workers` resolution requirement above) reports real,
non-zero coverage; a file reachable only through `wrangler.jsonc`'s separately-loaded `main` entry
point never does, even when a test's HTTP request causes that exact code to run. The distinguishing
factor is *whether the file is part of a test file's own directly-imported module graph* at
all, not whether its code executes during the test run.

**The actual, independent second root cause this same investigation had to fix first**: a test file
that tries to `import`/re-export `src/worker/index.ts` (or anything that transitively imports
`ReviewRunAgent.ts`) inside `tests/integration/vitest.config.ts`'s own Vite pipeline throws a bare
`SyntaxError: Invalid or unexpected token` the instant Vite tries to parse it — the *exact* same
root cause decision #39 already fixed for `vite.config.ts` (Vite/Rolldown cannot parse a bare
TC39 standard-decorators class member, `@callable()`, without `agents/vite`'s Babel transform),
rediscovered here because `tests/integration/vitest.config.ts` is a genuinely separate Vite
pipeline from the root `vite.config.ts`, with its own independent `plugins` array that decision
#39's fix never touched.

**Fix, in order**: (1) add `agents()` (from `agents/vite`) to `tests/integration/vitest.config.ts`'s
own `plugins` array, positioned before `cloudflareTest()` — this alone makes `src/worker/index.ts`
(and everything it imports) importable inside this project's Vite pipeline at all, with no
`SyntaxError`. (2) Drive the real Worker end to end via `exports.default.fetch()` (from
`cloudflare:workers`) instead of a standalone router-only Hono app — Cloudflare's own Vitest
integration docs confirm this gives "exactly the same module instance" `wrangler.jsonc`'s `main`
resolves internally for `exports` *and* every Durable Object/Workflow binding. Once (1) and (2)
are both true, `index.ts`, `access.ts`, `ReviewRunAgent.ts`, and `ReviewPipelineWorkflow.ts` all
report real coverage numbers (94–100% statements, comparable to every other file in the same
demo) with no `coverage.exclude` needed anywhere.

**A second, genuinely load-bearing consequence of the same "shared module instance" fact, needed
to drive `ReviewPipelineWorkflow`'s real reviewer steps without a live Workers AI account**:
Miniflare's own `ai` binding option (`WorkerOptions.ai`) accepts nothing but a real, credentialed
remote-proxy configuration (`V4RemoteBindingWithName`, confirmed by reading
`node_modules/miniflare/dist/src/index.d.ts` directly) — there is no equivalent to `kvNamespaces`'s
or `serviceBindings`'s own plain-JS-object local override for `ai` at all (consistent with
docs/DECISIONS.md #9's "Workers AI has no local simulator"). But `env.AI` (from `cloudflare:workers`)
is a genuine, mutable plain object, and — confirmed live, not merely inferred — a Durable
Object/Workflow defined in the same Worker script shares the *exact same* `env` object reference
the script's own top-level test-file code sees. Patching `env.AI.run`/`env.AI.gateway` directly
from a test file (`tests/integration/support/fixtures.ts`'s `installFakeAi()`) is therefore visible
to `ReviewPipelineWorkflow.run()`'s own `this.env.AI` calls, even though that Workflow instance
executes inside a Durable Object actor the test file never constructs directly. This is this
demo's only way to drive its real reviewer steps end to end with scripted AI responses and no
live account credentials, and is likely reusable by any future demo needing to fake an
otherwise-un-mockable Workers-AI-shaped binding inside `@cloudflare/vitest-pool-workers`.

**One more real API-surface finding worth recording**: `AiGatewayLogNotFound`
(`worker-configuration.d.ts`) is an ambient TypeScript **interface** (`interface
AiGatewayLogNotFound extends Error {}`), never a constructible or importable runtime symbol —
there is no module path to import it from at all. `ReviewPipelineWorkflow`'s own
`reconcile-cost:<role>` step catches this with a bare `catch {}` that never inspects the error's
type, so a test simulating "AI Gateway has not yet indexed this log" needs nothing more than a
plain `new Error(...)` thrown from a fake `getLog()`.

## NEW DECISIONS

## 41. A `destinations`-scoped `cloudflare_zero_trust_access_application`'s own `domain` value
    must literally match one of its `destinations` entries, confirmed live during
    `demos/review-agent`'s first real `terraform apply`

`terraform validate`/`plan` accept a `cloudflare_zero_trust_access_application` whose `domain` is
the bare hostname (`review-agent.cfapps.uk`) while its `destinations` list only two path-scoped
entries (`.../api/webhooks/github`, `.../api/webhooks/gitlab`) with no complaint at all — the
schema itself does not encode this constraint. `apply` against the real API rejects it outright:
`400 { "code": 12130, "message": "access.api.error.invalid_request: domain not included in
destinations" }`. `demos/url-shortener`'s own already-working second, narrower `admin` application
(AGENTS.md's own canonical "second, more-specific application" example is modeled on it) happens
to set `domain` to its own *first* `destinations` entry rather than the bare hostname — not
called out anywhere as a required convention, easy to read as an arbitrary stylistic choice, and
in fact load-bearing: the real API requires `domain` to be one of the values already listed in
`destinations` whenever `destinations` is set at all.

**Fix**: for any `cloudflare_zero_trust_access_application` that sets `destinations`, always set
`domain` to exactly one of those same `destinations` entries' `uri` value — never the bare
hostname a `destinations`-free application would otherwise use. `terraform plan` alone cannot
catch a violation of this; only a real `apply` does, so this is confirmed by running one against
this demo's own account, not merely by reading the schema. AGENTS.md's own "Public Access"
canonical example already happens to follow this convention correctly (its `admin` application's
`domain` is `"${var.demo_name}.${var.demo_domain}/admin*"`, its own first `destinations` entry) —
this decision exists so a future demo copying that shape with different path values does not
independently rediscover the same `400` by choosing the bare hostname instead, which reads as the
more natural first guess for `domain` on an application that is conceptually "the whole hostname's
exception," as `demos/review-agent`'s own first draft did.

## NEW DECISIONS

## 42. `docs/ISSUE-5.md` root cause — `AI_CHAT_MODEL` speaks the OpenAI-chat wire shape, not the
    Cloudflare-native one; a tool-instructing prompt must never be sent without its tools; the
    model truncates nested tool arguments; and the model needs the current graph's ids

`docs/ISSUE-5.md` reported that the Architect blueprint's "Generate with AI" chat produced no
diagram at all, narrated raw `<tool_call>`/`create_node` markup at the user as prose, and rendered
the assistant's answer twice. These are six independent defects, five server-side and one
client-side, all confirmed empirically against the **real** `@cf/zai-org/glm-5.2` (decision #35)
rather than reasoned about from types — Workers AI has no local simulation (decisions #9/#11/#36),
so the only way to learn this model's actual wire shape is to call it. Probing used
`POST /accounts/{id}/ai/run/@cf/zai-org/glm-5.2` with the demo's own `.env` credentials, plus a
throwaway harness driving the real `runDiagramChatTurn()` end to end over the same REST endpoint.

**The response is OpenAI-chat shaped, and `function.arguments` is a JSON *string*.** Non-streaming
responses carry `choices[0].message.tool_calls[]`, each entry `{ id, type: "function",
function: { name, arguments } }` with `arguments` a serialized JSON document — *not* the
Cloudflare-native top-level `{ response, tool_calls: [{ name, arguments: {...} }] }` shape with
parsed argument objects and no ids that `demos/architect/EXPLAIN-DEMO.md` claimed and that the
original `runNonStreamingRound()` read. Reading `result.tool_calls` against this model therefore
found zero tool calls on every single turn, which is the whole "no diagram is ever produced" half
of the issue. Streamed responses are the same shape one delta at a time: text as
`choices[0].delta.content`, and tool calls as `choices[0].delta.tool_calls[]` *fragments* keyed by
`index`, where the opening fragment for a call carries `id` and `function.name` with empty
arguments and every later fragment carries `id: null`/`name: null` and one slice of the arguments
text, to be concatenated in arrival order. **Both shapes are now read** (`extractObjectToolCalls`,
`extractObjectText`, `extractStreamDelta`, `accumulateToolCallDeltas`), openai-chat first and the
Cloudflare-native shape as a fallback, so this code does not newly hard-code itself to one vendor
shape while fixing a bug caused by hard-coding the other.

**This model is a reasoning model, and `delta.reasoning_content` must never be relayed to the
user.** Chain of thought arrives interleaved with real answer text on its own delta field. Only
`delta.content` reaches `onToken`.

**A tool-instructing system prompt sent *without* `tools` makes the model narrate tool-call markup
as prose.** The original design ran a final, deliberately tool-less round to get the closing
natural-language answer, while still sending the same system prompt that documents the tool
catalog — so the model dutifully "called" the tools the only way it could, by typing
`<tool_call>`/`<invoke>`/`create_node` into its answer. This exactly reproduces
`spikes/03-agent-skills-composability/REPORT.md` §7's own earlier finding, now confirmed a second
time on a different model. **Decision: every round carries `TOOL_DEFINITIONS`, including the final
one.** The round budget alone (`MAX_TOOL_ROUNDS` plus one trailing round whose tool calls are
ignored) terminates the loop; withholding the tools is not needed for that and actively causes
this. Two regression tests assert `tools` is present on *every* recorded round.

**Related: each round is now exactly one inference call.** The original loop ran a non-streaming
round to collect tool calls and then, for the final answer only, a *second* streaming call whose
result duplicated work already done. Collapsing to one streamed call per round removes the
duplicate inference (and its cost/latency) and is what makes "carry the tools on every round"
expressible at all.

**The model truncates a tool call's streamed `arguments` when the last field is a nested object,
and echoing invalid JSON back is a hard `400`.** When `add_node`'s optional `position` is the final
argument, the `}}` closing both the nested object and the argument object arrives on the wire as a
single `}`. Every affected call is otherwise complete. Left alone this made *every* positioned
`add_node` unparseable; and echoing the raw text back in the follow-up assistant message fails the
request outright with `AiError: Assistant tool call function.arguments must be valid JSON`, taking
the whole turn down rather than just that one call. **Decision: repair by appending exactly the
closers the document's own brace/bracket stack still has open** (`closeTruncatedJson`), and echo
the *re-serialized parsed* arguments (`toWireToolCall`), substituting `{}` when the text is not
parseable at all so a single bad call degrades to one recoverable tool error instead of a fatal
`400`. The repair deliberately **refuses** two cases: text ending inside an unterminated string
literal (real content was lost mid-value; inventing a closing quote would silently produce a
truncated node label instead of an honest error the model can retry), and mismatched closers
(genuine corruption, not truncation). Both refusals are tested.

**The model was never shown the diagram it was editing, so it invented ids.** Node and edge ids
are server-side `crypto.randomUUID()`s minted by `graph-mutations.ts`. With no id in the prompt a
model asked to wire nodes together passes each node's *label* where an id belongs, `addEdge()`
rejects every call with `notFound()`, and the turn burns its entire round budget failing — the
observed behavior was eight `add_edge` calls rejected, then the model apologizing about "a timing
issue" and retrying the same eight the same way. Fixed on two axes: a new
`buildGraphPromptContext(graph)` digest (each node's `id`/`typeId`/`label`, each edge's
`id`/`source`/`target`/`edgeType`, plus an explicit "use these exact ids, never a label"
instruction) is rebuilt into `turnMessages[0]` before **every** round, not just the first; and each
successful mutation's `role: "tool"` result now names the id it just created
(`describeMutationResult`). Positions, descriptions and viewport state are deliberately omitted
from the digest — none of them changes which id a tool call should name, and this text is rebuilt
on every round of every turn.

**A corollary that is easy to get wrong: the *caller's* graph is authoritative.** `applyMutation`
(really `DiagramSession.applyOperation()`) mints the ids that end up in storage. If the chat engine
re-derives its own local copy by re-running `applyGraphOperation()`, it mints *different* UUIDs, so
the ids it reports and prints are not the ids that exist — reintroducing the invented-id failure in
a form that is much harder to see. `ApplyMutationResult` therefore gained an optional `graph` that
`DiagramSession` now populates, and the engine adopts it in preference to its own copy. This was
also, verbatim, the last bug in the throwaway verification harness itself, which is how confidently
it can be asserted to be a real trap and not a hypothetical one.

**Client-side: reading a ref inside a deferred state updater duplicated the assistant bubble.**
`useDiagramLiveSync.ts`'s `chat_done` handler cleared `activeAssistantEntryIdRef` and then read it
again *inside* the `setState` updater, which React may run later — and does run in the same batch
as the preceding `chat_token` frames under `StrictMode`/automatic batching, at which point the
updater no longer finds the streamed entry to finalize and appends a second one instead. **Decision:
resolve every id and ref synchronously, outside the updater, keeping the updaters pure.** The
regression test drives `chat_token` and `chat_done` in one batched render and was confirmed to fail
(two assistant entries) with the fix reverted.

**Verification note for anyone reproducing this.** Driving `runDiagramChatTurn()` against the real
REST endpoint from Node needs the SSE body handed to the engine *unteed*: wrapping it in
`ReadableStream.tee()` to log the raw frames on the side deadlocks the turn part-way through a
round, which reads exactly like the model hanging. Log inside the engine's own SSE reader instead.
A full nine-node/nine-edge blueprint generation takes ~19 tool calls across four rounds and several
minutes wall-clock, so give any such harness a generous timeout and per-request `AbortSignal`.

## 43. A replicated operation must carry the ids it creates — the collaboration protocol's
    `add_node`/`add_edge` were not replayable, silently dropping every AI-authored edge; plus
    Markdown rendering and honest chat-transcript ordering

Three findings from `docs/ISSUE-5.md`'s follow-up round of manual validation against the deployed
demo. The first is a genuine protocol defect in 9C's collaboration layer that 9D's AI chat is
simply the first feature to exercise hard; the other two are 9D presentation bugs.

**`operation_applied` is a replicated message, so every operation on it must be deterministic —
`add_node`/`add_edge` were not.** `src/graph-mutations.ts`'s `addNode`/`addEdge` minted
`crypto.randomUUID()` *inside* the function, and the operation itself carried no id. But
`DiagramSession.applyOperation()` applies the operation to its own authoritative graph and then
broadcasts **the same id-less operation**, which every connected browser re-applies to its own
local store (`diagramStore.ts`'s `applyRemoteOperation`). Each replica therefore minted a
*different* id and diverged from the Durable Object permanently — there is no periodic resync,
since `graph_snapshot` is only sent on connect and on whole-graph writes. The user-visible symptom
was severe and easy to misread as an AI failure: the assistant would create six nodes and then
connect them, the chat would report the connections as made, and the editor would show **no edges
at all**. What actually happened is that each `add_edge` named the Durable Object's own node ids,
which existed nowhere in the browser's diverged copy, so `addEdge()` threw `notFound()` and
`applyRemoteOperation`'s `catch` — there to tolerate genuinely stale targets — swallowed it
silently. The same divergence is why the transcript printed "Connected a node → a node": the
label lookup missed too. Worst of all, `GenerateWithAiModal.handleOpenInEditor()` then read the
browser's diverged store and `PUT` it back over the diagram, so clicking "Open in Editor"
**destroyed the correct, edge-bearing graph that was already persisted in D1**. Nothing warned;
the data was simply gone.

**Decision: make the two creating operations carry their own id.** `AddNodeInput`/`AddEdgeInput`
gained an optional `id`; `addNode`/`addEdge` use `input.id ?? crypto.randomUUID()` and reject an
id already in use. `DiagramSession.applyOperation()` runs a new `withReplicableIds(op)` **before**
applying, so the operation it applies and the operation it broadcasts are byte-for-byte identical.
The browser now sends the id it already applied optimistically, so its own edit round-trips
unchanged instead of the object silently renaming it. This was fixed at the protocol level rather
than only for `ai-chat`-origin operations because the defect is not AI-specific — a remote human
edit and a 9B MCP tool call replicate through exactly the same path and had exactly the same bug;
it simply took an actor that creates many nodes and then immediately references them by id to make
it obvious. Regression coverage is an integration test asserting the broadcast operation carries
the id that was actually persisted, and a second one that uses ids learned from `add_node`
broadcasts as `add_edge` endpoints — the exact sequence that used to fail.

**The assistant writes Markdown, and the panel rendered it as literal characters.** The model
emits headings, bold, bullet lists, fenced code and GFM tables unprompted; `AiChatPanel` rendered
`<p>{entry.text}</p>`, and with no `white-space: pre-wrap` even the newlines collapsed, so a
structured answer arrived as one run-on line full of `**` and `|`. Added `react-markdown` +
`remark-gfm` (`remark-gfm` is what turns the very common table output into a real `<table>`).
Deliberately **no** `rehype-raw`: `react-markdown` ignores embedded HTML by default, and that
default is what stops model-authored text from being an HTML injection vector. The new CSS is
scoped under `.ai-chat-panel__markdown` and is about legibility in a ~260px-wide docked sidebar
rather than rich styling; links inherit the bubble's already-vetted text color and rely on an
underline, avoiding a new color needing its own contrast check in both themes.

**The transcript both duplicated and misordered itself.** Three causes, fixed together. (1) Every
graph mutation produced *two* lines — a `chat_status` from the Worker ("Adding node "API"…") and
an `"action"` entry from the `operation_applied` broadcast ("Added node: API"). Worse, the status
was emitted **before** `applyMutation` ran, so a rejected operation still announced itself as
done: that is what made the transcript claim edges had been connected when they had not. The
pre-apply `onStatus` for graph operations is gone; the confirmed broadcast is the single narration,
and `onStatus` now serves only `rename_diagram` and the docs lookup, neither of which broadcasts
anything of its own. (2) An assistant bubble stayed anchored wherever its first token landed while
every status/action/docs entry appended to the end, so a turn that narrated, called tools, then
narrated again put its closing summary *above* the tool activity that preceded it. A new
`appendInterruptingEntry` clears the active-bubble anchor whenever a non-assistant entry is
appended, so the next token opens a fresh bubble beneath it and the transcript reads
chronologically. Consequently `chat_done` no longer rewrites "the" bubble with the turn's whole
`assistantText` — a turn may now own several bubbles, and `assistantText` is by construction the
concatenation of exactly the tokens already rendered, so rewriting would duplicate every earlier
bubble's prose into the last one; it now only records the answer when nothing streamed at all.
(3) `GenerateWithAiModal` echoed its own synthesized instruction ("The user wants: …Propose an
initial Cloudflare architecture using only the available product types…") back as the user's
message. `sendChatMessage` gained an optional `displayText` so the model gets the full prompt
while the transcript shows only what the user typed.

**Deferred, and filed instead: `docs/ISSUE-6.md`.** "Open in Editor" also loses the conversation —
the editor lands with the sidebar closed on the Properties tab and an empty transcript. Landing on
the chat tab is a few lines, but the transcript lives in component state and the model's history is
per-WebSocket-connection, so a rehydrated transcript would face an amnesiac model. That is a design
question (persist chat history in the `DiagramSession` Durable Object and make the assistant a real
agentic loop over the diagram) rather than a patch, so it is written up separately rather than
half-solved here.
