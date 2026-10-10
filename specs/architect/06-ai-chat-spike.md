# Architect — Phase 21 AI chat, model, gateway and session spike

## 1. Why this report exists

[`02-implementation.md`](./02-implementation.md)'s Phase 21 deliberately changes no production code.
The source AI-assistance design, `~/gitlab/cf-demos/docs/09D-ARCHITECT-AICHAT.md`, was written for a
Wrangler deployment: its infrastructure section instructs the implementer to edit a
`wrangler.jsonc.tpl`, which does not exist in this repository and may not be created
([root AGENTS.md](../../AGENTS.md): "Never use Wrangler in this repository"). Its model bullet cites
a changelog entry rather than a model page. And the decision records that close out the source
project's own Phases 21, 23 and 26 (`~/gitlab/cf-demos/docs/DECISIONS.md` #35, #36, #37, #42, #43)
were written against a differently-shaped `DiagramSession`, a different integration-test pool
configuration, and — crucially — a protocol that had already been patched for a defect this port
still has.

Everything below was rechecked on **2026-10-10**. Documentary findings came from current Cloudflare
documentation, retrieved live through the `cloudflare-docs` MCP server and direct page fetches, and
from the real published `@modelcontextprotocol/client` tarball. Empirical findings came from
throwaway integration probes registered in the same `tests/integration/vitest.config.ts` Workers
pool as
[`live-sync.test.ts`](../../cf-terraform-demos/architect/tests/integration/live-sync.test.ts), and
from one raw `curl` against a public, unauthenticated endpoint. Every probe file was deleted after
it ran. No Worker, D1 database, Terraform state, AI Gateway, or other cloud resource was created,
changed, or destroyed; `terraform -chdir=infra init -backend=false` downloads a provider plugin and
makes no Cloudflare API call, and `terraform providers schema -json` reads that plugin locally.

**Each finding below is labelled documentary or empirical.** Two of them correct the source document
or an older decision record, and one of them is a live protocol defect in this port that the source
project already fixed and that nothing in the brief for this phase expected to still be open.

## 2. The model: `AI_CHAT_MODEL`

**Documentary.** No live `env.AI.run()` call was made. The `AI` binding has no local simulation
(Workers AI must be run remotely), the integration pool deliberately declares no `AI` binding at all
— a probe dumped the pool's `env` keys and confirmed `AI` is `undefined` there today — and making a
real call would spend account credit against a gateway this phase is not allowed to create.

### 2.1 The source document's model id is still valid, and still function-calling capable

[`@cf/zai-org/glm-5.2`](https://developers.cloudflare.com/workers-ai/models/glm-5.2/) is present in
the current catalog, is **not** on the
[planned-deprecations list](https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/),
and its own model page states **Function calling: Yes** with a 262,144-token context window,
reasoning levels `none`/`high`/`max` (default `max`), and unit pricing of \$1.40 per million input
tokens and \$4.40 per million output tokens. Its page also documents `tools[]`, `tool_choice` and
`parallel_tool_calls` as request parameters and `choices[]` as the response shape — which
independently corroborates decision #42's empirical finding that this model speaks the OpenAI-chat
wire shape rather than the Cloudflare-native `{ response, tool_calls }` one. "Paid access required":
it is unavailable on standard Workers Free billing and needs the Workers Paid plan or prepaid AI
Gateway credits.

### 2.2 Correction: the named fallback should be `@cf/zai-org/glm-5.3-flash`, not Kimi

Decision #35 named [`@cf/moonshotai/kimi-k2.6`](https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/)
as the fallback, and that model is still current and still lists **Function calling: Yes** with a
262,144-token context window. But two newer Z.ai models have landed in the catalog since #35 was
written, and both are better fallbacks for *this* demo:

| Model | Function calling | Context | Input \$/M | Output \$/M |
| --- | --- | --- | --- | --- |
| `@cf/zai-org/glm-5.2` (default) | Yes | 262,144 | 1.40 | 4.40 |
| `@cf/zai-org/glm-5.3-flash` (fallback) | Yes | 1,048,576 | 0.15 | 0.50 |
| `@cf/zai-org/glm-5.3` | Yes | 1,048,576 | — | — |
| `@cf/moonshotai/kimi-k2.6` | Yes | 262,144 | — | — |

[`glm-5.3-flash`](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/)'s own page
describes it as "the first natively multimodal model in the GLM-5 series … it outperforms GLM-5.2
across benchmarks and real-world workloads at one-tenth the price." For a demo whose AI Gateway
carries a deliberately small spend limit, a roughly 9× cheaper model from the **same family** — and
therefore the most likely to share `glm-5.2`'s exact wire behaviour, which is what
`src/worker/ai/chat-engine.ts` will be written against — is a materially better first thing to try
than a different vendor's model.

**Decision: default `AI_CHAT_MODEL` to `@cf/zai-org/glm-5.2`, and name
`@cf/zai-org/glm-5.3-flash` as the documented fallback** in the binding's own comment in
`cloudflare.config.ts`. Keep `glm-5.2` as the default rather than switching to the cheaper model
outright, because `glm-5.2` is the one model whose tool-calling wire behaviour this feature's design
was derived from empirically (decision #42: the OpenAI-chat fragment shape, the truncated-arguments
defect, the `reasoning_content` field), and adopting an unverified model as the default would make
every one of those findings a guess again. Switching is a one-line `bindings.text()` edit and a
redeploy.

### 2.3 What is still unproven, and whose job it is

Decision #35's residual uncertainty stands and is restated here rather than inherited silently:
documented function-calling support is **not** the same as "returns well-formed `tool_calls` through
this specific gateway shape." Decision #13 found several otherwise-capable models fail with
`AiGatewayError 2002` through an AI Gateway **dynamic route**; this demo uses a plain gateway, so
that exact failure may not apply, but it has not been retested. Closing this is **Phase 23's** job,
via its first real deployed turn — not something Phase 21 can settle, and not something Phase 22
needs settled, since Phase 22's modules never call the binding.

## 3. AI Gateway as Terraform infrastructure

**Empirical** (local schema inspection), against the provider version this repository actually
pins. `infra/providers.tf` declares `cloudflare/cloudflare ~> 5.22`; `infra/.terraform.lock.hcl`
resolves that to **5.27.0**. `terraform -chdir=infra init -backend=false` followed by
`terraform providers schema -json` reports, for `cloudflare_ai_gateway`:

**Required** (a `plan` fails outright with "argument is required" if omitted):

```text
account_id   id   cache_invalidate_on_update   cache_ttl   collect_logs
rate_limiting_interval   rate_limiting_limit
```

**Optional but also `computed`** — the API fills these server-side, so leaving one unset produces
perpetual plan drift and every one must be pinned explicitly:

```text
authentication   byok_only   log_classification   log_management
log_management_strategy   logpush   store_id   workers_ai_billing_mode   zdr
spend_limits (single-nested; .enabled and .rules are themselves optional+computed)
otel (list)
```

**Optional, not computed** (safe to omit entirely):

```text
rate_limiting_technique   retry_backoff   retry_delay   retry_max_attempts
logpush_public_key   dlp   guardrails   stripe
```

**Computed only**: `created_at`, `modified_at`, `is_default`.

`spend_limits.rules[]` nests `limit_type` (required), `limit` (required, number) and `window`
(required, number) — exactly the three fields the source document's HCL sets — plus
`enabled`/`id`/`technique` (optional+computed) and optional `model`/`metadata`/`ai_gateway_provider`
selectors.

### 3.1 Corrections to decision #35 item 4

Decision #35 recorded that `authentication`, `logpush`, `log_management`,
`log_management_strategy` and `zdr` are "`optional`, **not** `computed`." In 5.27.0 all five are
`optional+computed`. The practical instruction is unchanged — pin them — but the *reason* is the
drift reason, not the "argument is required" reason, and #35 had those two classes the other way
round for this group. Three fields #35 did not mention are also `optional+computed` and must
likewise be pinned: `byok_only`, `log_classification` and `workers_ai_billing_mode`. The last is
new and matters here: it selects whether a Workers AI call through this gateway bills against the
Workers plan or against prepaid AI Gateway credits, which for a "paid access required" model is a
decision worth writing down rather than inheriting.

### 3.2 Correction to the source document's HCL: `rate_limiting_technique` is absent

The source document's quoted block sets `rate_limiting_interval` and `rate_limiting_limit` but no
`rate_limiting_technique`. That field exists, is optional-and-not-computed, and
`cf-terraform-demos/playground/infra/playground.tf` — this repository's own, working, current
precedent — sets it to `"sliding"`. Phase 23 should set it too: a rate limit without a stated
technique is a configuration whose behaviour a reader cannot predict from the file.

### 3.3 The repository's own precedent is the model to copy, not the source HCL

`playground/infra/playground.tf`'s `cloudflare_ai_gateway "demo"` block already pins every required
and every optional+computed field this schema dump lists, with a comment per field explaining the
choice, and `playground/cloudflare.config.ts` already binds `AI: bindings.ai()` and
`AI_GATEWAY_ID: bindings.text(values.aiGatewayId)`. Phase 23 should follow that file, adjusting only
the values this demo needs differently: `cache_ttl = 0` and `cache_invalidate_on_update = true`,
because a chat turn is not cacheable and caching a tool-calling round would be actively wrong;
`authentication = false`, because this gateway has exactly one caller (the Worker's own binding) and
no provider-native endpoint is published for it — note that `playground` chose `true` for the
opposite reason, so this difference is a real decision and needs its own comment; and a small
`spend_limits` cost rule, which is the thing a presenter points at.

### 3.4 `.env.example` already grants what Terraform needs

**Empirical.** The repository-root `.env.example` already lists both `AI Gateway: Edit` (line 14)
and `Workers AI: Edit` (line 16) among the documented API-token permissions. No change is needed
there, and Phase 23's README update should say so rather than instructing a reader to add them.

## 4. The tool-call wire schema

**Documentary here; empirically established by decision #42 against the real model.** This section
exists so Phase 23's implementer does not have to re-derive it, because the cost of getting it wrong
is not a type error — it is a chat that silently produces no diagram at all, which is exactly what
`~/gitlab/cf-demos/docs/ISSUE-5.md` reported.

### 4.1 The request

Per the current
[AI Gateway Workers-binding reference](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/),
one round is:

```ts
await env.AI.run(
  env.AI_CHAT_MODEL,
  { messages, tools: TOOL_DEFINITIONS, stream: true },
  { gateway: { id: env.AI_GATEWAY_ID } }
);
```

`gateway.id` is the only required gateway option; `skipCache`, `cacheTtl`, `cacheKey`, `collectLog`
and `metadata` are the others, and none is needed here. `messages` carries four roles, not two:
`system` (the rebuilt prompt), `user`, `assistant` (with a `tool_calls` array when echoing back what
the model just called), and `tool` (with a `tool_call_id` matching the call it answers). The
platform's generated `Ai.run()` overloads cannot express this for a model id that is not a literal
key of `AiModelList`, so the engine declares its own narrow binding interface and the Durable Object
casts `this.env.AI` to it at the single call site, with the cast justified in a comment there.

### 4.2 The response, and the five things that must be read correctly

1. **It is OpenAI-chat shaped, not Cloudflare-native.** Non-streaming responses carry
   `choices[0].message.tool_calls[]`; there is no top-level `tool_calls`. Reading `result.tool_calls`
   against this model finds zero tool calls on every turn. The engine must read the `choices` shape
   first and keep the Cloudflare-native `{ response, tool_calls }` shape only as a fallback, so it
   does not newly hard-code itself to one vendor shape while fixing a bug caused by hard-coding the
   other.
2. **`function.arguments` is a JSON *string*, not an object.** Streamed, it arrives as
   `choices[0].delta.tool_calls[]` **fragments keyed by `index`**: the opening fragment for call `n`
   carries `{ index: n, id, function: { name, arguments: "" } }`, and every later fragment carries
   `id: null`/`name: null` and one slice of the arguments text, to be concatenated in arrival order.
   A chunk may interleave fragments for several indices, so the accumulator must be a
   `Map<number, …>` and must not assume one call finishes before the next begins.
3. **The model truncates arguments when the last field is a nested object.** When `add_node`'s
   optional `position` is the final argument, the `}}` closing both the nested object and the
   argument object arrives as a single `}`. Left alone this makes *every* positioned `add_node`
   unparseable. Repair by appending exactly the closers the document's own brace/bracket stack still
   has open, and **refuse** two cases: text ending inside an unterminated string literal (real
   content was lost mid-value, and inventing a closing quote would silently produce a truncated node
   label instead of an honest error the model can retry) and mismatched closers (corruption, not
   truncation). Echo the **re-serialized parsed** arguments back in the follow-up assistant message,
   substituting `{}` when the text is unparseable: echoing invalid JSON fails the whole request with
   `Assistant tool call function.arguments must be valid JSON`, turning one recoverable tool error
   into a dead turn.
4. **`delta.reasoning_content` must never reach the user.** This is a reasoning model with `max`
   effort as its documented default, and it streams its entire chain of thought on that separate
   field, interleaved with real answer text. Only `delta.content` may reach `onToken`.
5. **Every round carries the tools, including the last one.** A tool-instructing system prompt sent
   *without* `tools` makes the model narrate `<tool_call>`/`<invoke>` markup at the user as prose.
   The round budget alone terminates the loop; withholding the tools is not needed for that and
   actively causes this. Two regression tests must assert `tools` is present on *every* recorded
   round. Correspondingly, each round is exactly **one** streamed inference call — an earlier design
   ran a non-streaming round to collect tool calls and then a second streaming call for the final
   answer, which generated and billed for the whole answer twice.

### 4.3 The graph-id corollary

The model must be shown the ids it is editing. Node and edge ids are server-side
`crypto.randomUUID()` values minted in `src/worker/domain/graph-mutations.ts`; with no id in the
prompt, a model asked to wire nodes together passes each node's *label* where an id belongs, every
`add_edge` is rejected with `notFound()`, and the turn burns its whole round budget failing. The
fix has two halves, and both are needed: a graph digest (each node's `id`/`typeId`/`label`, each
edge's `id`/`source`/`target`/`edgeType`, plus an explicit "use these exact ids, never a label"
instruction) rebuilt into the system message before **every** round, not once per turn; and each
successful mutation's `role: "tool"` result naming the id it just created. Positions, descriptions
and viewport state are deliberately omitted — none changes which id a tool call should name, and
this text is rebuilt on every round of every turn.

The second half of the corollary is the trap: **the caller's graph is authoritative.** The session
mints the ids that reach storage, so if the engine re-derives its own post-operation graph by
re-running `applyGraphOperation()` it mints *different* UUIDs and reports ids that exist nowhere.
`ApplyMutationResult` must therefore carry the authoritative graph back from the session, and the
engine must prefer it over its own copy.

## 5. Cost and log correlation

### 5.1 What AI Gateway logs, and where the presenter looks

**Documentary.** The current
[AI Gateway logging guide](https://developers.cloudflare.com/ai-gateway/observability/logging/)
states that each log "can include the prompt, response, provider, timestamp, status, token usage,
cost, duration, and user agent," and the
[analytics guide](https://developers.cloudflare.com/ai-gateway/observability/analytics/) confirms
the dashboard shows requests, tokens, caching, errors and cost, filterable by time. That dashboard
— **AI → AI Gateway → the gateway → Logs / Analytics** — is where a presenter sees this feature's
cost, and it is the reason the gateway exists at all for this demo: with `collect_logs = true` and
every call carrying `{ gateway: { id } }`, "every inference request is observable in one place" is a
property of the code rather than a claim in a README.

One operational caveat worth putting in the README: gateways created on or after 2026-09-24 follow
Workers Logs pricing and retention; older ones use Legacy Logs. A freshly provisioned demo gateway
is therefore on the Workers Logs path.

`env.AI.aiGatewayLogId` returns the log id of the most recent `env.AI.run()`, and
`env.AI.gateway(id).getLog(logId)` reads that entry back. Neither is needed for this feature and
neither should be added: this demo's claim is that the *dashboard* shows the cost, and reading a log
back into the Worker would add a round trip and an error path for no visible benefit. (The
`playground` demo does use `getLog()`, because showing per-request cost *in the application UI* is
that demo's whole point. The two demos teaching different lessons is deliberate.)

### 5.2 The privacy rule

Three structured events, and **none of them carries prompt text, response text, documentation
snippets, or diagram content**:

| Event | Fields | Emitted from |
| --- | --- | --- |
| `ai_chat_turn_completed` | `diagramId`, `model`, `toolCallCount`, `mutated`, `latencyMs` | `DiagramSession` |
| `ai_chat_turn_failed` | `diagramId`, `reason` | `DiagramSession` |
| `ai_docs_lookup_performed` | `resultCount`, `latencyMs` | the chat engine's docs-tool branch |

`ai_docs_lookup_performed` records the result count and the latency, never the query text and never
the returned snippets. `ai_chat_turn_failed`'s `reason` is an error message, so Phase 23 must keep
it to the thrown `Error.message` and never widen it to a response body. The gateway may still log
payloads — that is the gateway's behaviour, not the application's to guarantee — so the honest
framing for the README is that the Worker's own logs contain no content, not that nothing anywhere
does.

### 5.3 How to log from inside a Durable Object **in this repository**

**Empirical** (code inspection of this repo's actual logging surfaces). This is the finding that
does not transfer from the source project, and the brief was right to flag it.

`src/worker/logging.ts` in this port is **not** a logger. It exports exactly one thing: the
`LogVia = 'api' | 'mcp'` type, a shared vocabulary so two transports cannot spell the same field
differently. The actual logger is `@adrianhall/cloudflare-toolkit`'s `cloudflareLogger()`, which
resolves a request-scoped `Logger` onto a Hono `Context` at middleware time.
`@demos/worker-common` exports `createAccessMiddleware`, `currentIdentity`/`currentIdentityEmail`,
`createMeRouter`, `jsonBodyLimit`, `readJsonBody` and `upgradeRequired` — and no logging concern at
all.

`DiagramSession` has no Hono `Context`. A `webSocketMessage()` invocation is not a request; there is
nothing to hang a request-scoped logger off. Threading a `Logger` instance into the object across an
RPC or WebSocket boundary is not an option either: a `Logger` is not structured-cloneable, which is
the same constraint that already forced this project's graph operations to be values rather than
closures (`src/worker/domain/graph-operations.ts`'s own file comment documents the `DataCloneError`
that taught it).

**Decision: extend `src/worker/logging.ts` with a small, typed, dependency-free
`logSessionEvent(event)` helper and use it for all three events.** Not bare `console.log` at three
call sites, which is what decision #36 settled on for the source project. The difference is that
this port already has a module whose stated job is "the one vocabulary every structured log event in
this Worker uses," so the AI events belong beside `LogVia` rather than scattered as ad-hoc
`JSON.stringify` calls. Concretely: a discriminated union of the three event shapes, one function
that `JSON.stringify`s the event into a single `console.log`/`console.error` argument so Workers
Logs parses it as structured data, and a file comment stating plainly why this bypasses
`cloudflareLogger()`. That keeps the three events' field names checked by the compiler — which is
the whole reason `LogVia` exists — gives the privacy rule a single place to be enforced and tested,
and makes the helper unit-testable against a spied `console` with no Durable Object involved.

`cloudflare.config.ts` already sets `observability.logs.enabled` with `invocationLogs: true` and
`persist: true`, so nothing in the Worker configuration needs to change for these events to be
retained.

## 6. Durable Object lifecycle, and how the AI path will be tested

### 6.1 Async work outlives the client that started it

**Documentary, then empirical.** The current
[Durable Object lifecycle guide](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
lists the conditions for hibernation, and one is load-bearing here: hibernation can only occur if
"**no request/event is still being processed, because hibernating would mean losing track of the
async function which is eventually supposed to return a response to that request**." A
`webSocketMessage()` invocation's returned promise — which for a chat turn is the whole multi-round
`runDiagramChatTurn()` loop — is exactly such an event, so the object stays in the **active,
in-memory** state for as long as that promise is unresolved, regardless of whether the socket that
delivered the triggering message is still open.

The same page adds a detail decision #35 did not record, and Phase 23 must respect it: "Pending
operations prevent eviction … Each operation prevents eviction until it completes or **for up to 15
minutes** from when it starts, whichever comes first," and while an operation prevents eviction the
object continues to incur duration charges. A chat turn is bounded by `MAX_TOOL_ROUNDS` and each
round's own request, so 15 minutes is not a realistic ceiling for one turn — but it is the reason
every outbound call in this feature (the inference call and the docs lookup) needs its own timeout
rather than relying on the platform to end a hung turn, and it is the reason a runaway loop would be
a cost problem as well as a correctness one.

`webSocketClose()` is a separate, additional event delivered to the object, not a signal that
unwinds in-flight work: JavaScript inside one Durable Object instance is single-threaded and
cooperative, so a close event cannot preempt an `await` chain any more than a second concurrent
`operation` frame could — the same no-interleaving property
[`05-collaboration-spike.md`](./05-collaboration-spike.md) §2.2 already established for this
project, and which that report was careful to scope to the synchronous interval rather than the
whole async method.

A throwaway probe confirmed the observable consequence against the real `DiagramSession`. A client
sent an `add_node` frame and called `socket.close()` **immediately**, without waiting for any
answer. Polling D1 directly (rather than racing a frame against a timer, per this suite's own rule)
found the node persisted, and a freshly opened socket's connect snapshot contained it. A second
probe sent an operation, awaited its `operation_applied`, closed the socket, called
`evictAllDurableObjects({ webSockets: 'close' })`, and reconnected: the new snapshot still carried
the node, at `sequence: 0` — the restarted counter that is itself the discontinuity marker a
reconnecting client resynchronises across. Both paths therefore reflect a completed turn, which is
the property `09D`'s "Why This Runs Inside `DiagramSession`" section depends on.

**No correction to the source document's design on this point.** Phase 23's own disconnect-mid-turn
test remains the right place to prove it for a *chat* turn specifically; the probes above prove the
transport-level property the chat turn will inherit.

### 6.2 The `env` override technique works here — with a caveat decision #37 does not mention

**Empirical.** This was the one coded spike clearly worth running, because the whole Phase 23/26
test strategy rests on it. Six throwaway probes, all since deleted:

1. **`runInDurableObject(stub, (instance) => { instance.env.AI = fake })` works.** A later call
   against the same stub reached the fixture. `instance.env` is an ordinary mutable JS property on
   the live instance the helper hands back, not a runtime-enforced read-only binding site.
2. **A real method body reads the substitution, not a value captured at construction.** Substituting
   `instance.env.DB` with a fake and then calling the real `getSnapshot()` RPC returned the fake
   row's `updatedAt`. `hydrate()` constructs `new D1DiagramRepository(this.env.DB)` on first use, so
   this proves the property is read at call time — exactly the seam `this.env.AI` will be.
3. **The stub addresses the same live instance a socket is already attached to.** After opening a
   socket through the real Worker route, `runInDurableObject` on `getByName(diagramId)` saw
   `ctx.getWebSockets().length === 1`. A substitution applied *after* a socket is open is reached by
   that socket's later frames.
4. **Caveat, and it is not in decision #37: the substitution is process-wide, not per-instance.**
   Setting `instance.env.SPIKE_MARKER` inside one object made the marker visible to a *different*
   Durable Object instance **and** to the test module's own imported `env`. The converse also holds:
   assigning directly on the test module's `env` is visible inside the object, with no
   `runInDurableObject` call needed at all. `instance.env === testEnv` is `false` — they are
   distinct objects — but they evidently share their backing, so a mutation on either is seen by
   both.
5. **It survives eviction.** After `evictAllDurableObjects()`, a freshly constructed instance still
   saw the injected binding. The substitution is not reset by reconstruction.
6. **The leak is observable as a test failure, not as a mystery.** An early draft of probe (2) left
   its fake `DB` in place; the *next* test's `createDiagram()` fixture immediately failed with
   `HTTP 500`. Restoring the real binding in a `finally` fixed it.

**Decision: use this technique for Phase 23's and Phase 26's AI-path integration tests, and require
every such test to restore the binding it replaced.** Points 4–6 together mean an unrestored
substitution is a cross-test contamination bug, and `fileParallelism: false` plus a shared `workerd`
runtime means it can reach a *different file*. The safe shape is a fixture helper in
`tests/integration/live-sync-fixtures.ts` — something like `withFakeAi(fake, async () => { … })` —
that assigns, awaits the body, and restores in a `finally`, so no individual test can forget. The
simplest assignment form (directly on `testEnv`, per point 4's converse) is sufficient and avoids
needing a `runInDurableObject` round trip at all; prefer it, and keep `runInDurableObject` for cases
that genuinely need the instance.

This closes decision #36's accepted gap for this port before it is ever opened: the brief's
suggestion that `handleChatMessage`'s success path might be an accepted coverage exception is
**not** true here. It is reachable.

### 6.3 The integration project already supports this

No `tests/integration/vitest.config.ts` change is needed for the Durable Object or testing
mechanics: `DIAGRAM_SESSIONS` is already declared SQLite-backed with the real class,
`fileParallelism: false` serializes files sharing the runtime, `testTimeout: 10_000` and
`hookTimeout: 15_000` are finite, and the suite already evicts with `{ webSockets: 'close' }` in
`afterEach`. Phase 23 adds only the two new string bindings (`AI_GATEWAY_ID`, `AI_CHAT_MODEL`) so
the Durable Object can read them; it must **not** add an `ai` binding to the Miniflare config, since
Workers AI cannot run locally and a declared binding would turn every unstubbed call into a remote
one. The existing body-draining and fresh-diagram-id rules from
[`05-collaboration-spike.md`](./05-collaboration-spike.md) §4 apply unchanged.

## 7. The MCP documentation client

**Empirical.** `npm view @modelcontextprotocol/client` reports **2.3.1** as both the current
version and `latest`. `@modelcontextprotocol/server` is at the same version, and this repository
pins `@modelcontextprotocol/server@2.0.0` in `package.json` **dependencies**.

Unpacking the real published `@modelcontextprotocol/client@2.0.0` tarball and reading its
`dist/index.d.mts` confirms both required symbols are in the package's top-level export statement:
`declare class Client extends Protocol<ClientContext>` and
`declare class StreamableHTTPClientTransport implements Transport`. The package exposes `.` ,
`./stdio` and `./validators/ajv` subpath exports with both ESM and CJS types.

**Decision: pin `@modelcontextprotocol/client@2.0.0`**, matching the already-pinned server package
exactly rather than taking `2.3.1`. The two packages share a protocol implementation, and this demo
runs both an MCP *server* (Phases 11–15) and an MCP *client* in the same Worker bundle; two
different minor versions of the same SDK family in one bundle is a bigger risk than being three
patch-minors behind on a client whose two exports are confirmed present at the pinned version. It
goes in **`dependencies`**, not `devDependencies` — it is a real runtime import for
`src/worker/ai/docs-client.ts`.

The target server answers unauthenticated. A raw `curl -X POST https://docs.mcp.cloudflare.com/mcp`
with an `initialize` body and **no `Authorization` header** returned `HTTP 200` and a real result
(`serverInfo: {"name":"docs-ai-search","version":"0.4.13"}`, `protocolVersion: "2025-06-18"`,
advertising `tools` and `prompts` capabilities). A second `curl`, a bare `tools/call` for
`search_cloudflare_documentation` with **no prior `initialize` on that connection at all**, also
returned `200` with real ranked results — the server does not enforce session continuity across HTTP
requests, which is what makes the "connect, call one tool, disconnect" design correct rather than
merely convenient. Results arrive as a single text content block containing concatenated
`<result><url>…</url><title>…</title><text>…</text></result>` blocks, with no separator; that is the
format `docs-client.ts` must parse, and a response containing no such block must yield an empty
array rather than throwing.

**No correction to the source document's docs-client design.** Its "deliberately not the Agents
SDK's `MCPClientManager`" reasoning holds: that manager exists to hold a persistent connection's
OAuth tokens, reconnection and subscriptions, none of which a public stateless server needs.

## 8. A live protocol defect this port still has

**Empirical, and this is the finding that most changes the plan.** The brief for this phase stated
that decision #43's replicable-id fix "is already in place here" because `AddNodeInput`/`AddEdgeInput`
already accept an optional `id`, and asked for that to be verified. It is **half** in place, and the
half that is missing is the half that matters.

`src/worker/domain/graph-mutations.ts` does accept an optional `id` on both creating inputs
(`input.id ?? crypto.randomUUID()`, lines 252 and 355) and does reject an id already in use. The
browser already supplies one: `src/client/lib/graph-operation-diff.ts` puts `id: node.id` and
`id: edge.id` into every `add_node`/`add_edge` it generates, so a human editor's own operation
round-trips unchanged. The MCP tools expose an optional `id` too.

But `src/worker/infrastructure/diagram-session.ts` has **no `withReplicableIds()` step**. A grep for
it across the whole `src/` tree finds nothing. `runOperation()` applies the operation it was given
and then broadcasts *that same operation object* — so a **server-authored, id-less** `add_node`
persists a fresh UUID in the Durable Object's graph and broadcasts an operation carrying no id at
all. Every connected browser's `applyRemoteOperation` then re-runs `applyGraphOperation`, mints its
*own different* UUID, and diverges permanently; there is no periodic resync, since a snapshot is
only sent on connect, on a whole-graph write, and on request.

A throwaway probe confirmed it exactly. Calling
`DIAGRAM_SESSIONS.getByName(id).applyOperation({ kind: 'add_node', input: { label, typeId } }, actor)`
— precisely the shape an AI chat tool call will produce — while a socket was open gave:

```text
broadcastId: null          persistedId: "43ee38f5-7870-451b-b60a-9c790e528630"
```

Today this is latent: the MCP tools' own `id` parameter is optional but the existing integration
tests always pass one, and no current caller omits it in anger. The AI chat is the first actor that
will create many nodes server-side and then immediately reference them by id, which is exactly the
sequence that makes the divergence visible — in the source project it presented as the assistant
reporting six connections made while the editor showed **no edges at all**, and then "Open in
Editor" writing the browser's diverged graph back over the correct one in D1 and destroying it.

**Decision: fix this at the protocol level in Phase 23, before any chat code depends on it, and
not only for `ai-chat`-origin operations.** A `withReplicableIds(operation)` step in
`runOperation()`, before `this.apply(...)`, so the operation applied and the operation broadcast are
byte-for-byte identical. It is not AI-specific: a remote human edit and an MCP tool call replicate
through the same path and have the same bug today; it simply takes an actor that creates and then
references to expose it. Two regression tests: one asserting an id-less server-authored `add_node`
broadcasts the id that was actually persisted, and one using ids learned from `add_node` broadcasts
as `add_edge` endpoints — the exact sequence that fails now.

## 9. Concrete implementation deltas for Phases 22–26

### 9.1 No Wrangler, anywhere

The source document's entire `wrangler.jsonc.tpl` instruction set is void. Bindings are declared in
`cloudflare.config.ts`'s `env` block: `AI: bindings.ai()`,
`AI_GATEWAY_ID: bindings.text(values.aiGatewayId)`, and
`AI_CHAT_MODEL: bindings.text('@cf/zai-org/glm-5.2')` — a literal, because it is a static demo
choice with no resource behind it, exactly as the source document's own reasoning concludes even
though its mechanism differs. There is no `migrations`/`new_sqlite_classes` concern: `cf` models the
`DiagramSession` namespace as an `exports.durableObject({ storage: 'sqlite' })` entry that already
exists, and this feature adds no Durable Object storage at all.

Terraform gains the gateway in a new `infra/ai-gateway.tf` (one file per shared resource, per the
family rules), an `ai_gateway_id` output in `infra/outputs.tf` with a description, a matching
`aiGatewayId` entry in `infra/outputs.ts`'s `TerraformOutputs` **and** `OUTPUT_KEYS`, an
`"ai_gateway_id"` value in the committed `infra/local-outputs.json` (`"architect-local-ai"`), and
`cloudflare_ai_gateway.demo` added to `cloudflare_worker.demo`'s existing `depends_on` list.
`infra/outputs.ts`'s file comment currently says "the nine outputs"; it becomes ten.

### 9.2 Four-tier placement

The source document puts everything under a flat `src/worker/ai/`. That maps onto this port's tiers
as: `catalog-context.ts` and `tools.ts` are **domain** — pure, no binding, no D1, no socket, testable
against fixture `GraphData` exactly as `graph-mutations.ts` already is, and `tools.ts`'s zod schemas
validate `typeId`/`edgeType` against the live `src/catalog.ts` maps rather than a hard-coded enum
snapshot. `chat-engine.ts` is **application**: it orchestrates a use case and depends on injected
callbacks (`applyMutation`, `renameDiagram`, `onStatus`, `onToken`, `onDocsLookup`) and on a narrow
`ChatAiBinding` interface, never on `DiagramSession`, D1 or WebSockets. `docs-client.ts` is
**infrastructure**: it is an adapter over an outbound transport, and the engine should depend on a
port rather than importing it directly — which incidentally gives the one closure decision #37 had
to leave uncovered an injection seam, so this port need not inherit that exception either.

### 9.3 Protocol and vocabulary changes

`src/live-sync-protocol.ts` is this project's shared protocol file and the source document's
"whatever shared type definition 9C introduced" clause points straight at it. It gains
`'ai-chat'` on `ChangeOrigin`, a `ChatMessageFrame` in the `ClientFrame` union, and
`ChatStatusFrame`/`ChatTokenFrame`/`ChatToolResultFrame`/`ChatDoneFrame`/`ChatErrorFrame`/
`DiagramRenamedFrame` in `SessionFrame`. Both ends `switch` exhaustively on these unions, so the
build fails until `DiagramSession` and `DiagramCanvas` both handle every new frame — which is the
property that makes a shared file worth having, and the reason this port must **not** follow the
source project's inline-private-interface approach.

Inbound validation lives in `src/worker/domain/client-frame.ts` and must learn `chat_message`,
refusing a frame that invents an author field for the same reason every other frame does.
`DiagramSession.runOperation(operation, { actor, origin, operationId })` is the seam the chat turn's
`applyMutation` closure wraps, passing `origin: 'ai-chat'` and `operationId: null`; the public
`applyOperation()` RPC keeps its fixed `'agent'` origin, so the chat path needs its own private
entry rather than reusing it. `DiagramCanvas.tsx`'s remote-change notice currently reads
`remoteChange === 'agent' ? 'Updated by an agent' : 'Updated by another editor'` and needs a third
arm plus suppression for the connection that originated the turn.

### 9.4 Client

`src/client/components/editor/panels/DetailsPanel.tsx` **already exists**, with a
`details-panel__tablist` containing a single static `<span>` marked
`details-panel__tab--active`, and its own JSDoc already says "it is where a later layer's second tab
arrives without touching that form at all." Phase 24 turns that span into a real ARIA tab pair and
adds `AiChatPanel.tsx` beside `PropertiesPanel.tsx`. `src/client/lib/details-panel-preferences.ts`
already persists the expanded/compact width; `detailsPanelTab` is in-memory state and must **not**
be persisted, matching that file's existing stated rule that only width is remembered.

`react-markdown` + `remark-gfm` are needed: the model emits headings, bold, lists, fenced code and
GFM tables unprompted, and rendering them as literal characters in a ~260px sidebar is unreadable.
Deliberately **no** `rehype-raw` — `react-markdown` ignores embedded HTML by default, and that
default is what stops model-authored text being an injection vector.

Three transcript rules, each fixing a defect the source project shipped and then had to repair:
emit **one** narration per mutation (the confirmed `operation_applied` broadcast), never a
pre-apply `chat_status` as well, because a pre-apply status announces a rejected operation as done;
clear the active-assistant-bubble anchor whenever a non-assistant entry is appended, so a turn that
narrates, calls tools, then narrates again reads chronologically; and resolve every id and ref
**synchronously, outside** a `setState` updater, since reading a ref inside a deferred updater
duplicates the assistant bubble under automatic batching.

### 9.5 Verification

Phase 26 replaces the source document's "Wrangler generation/type checks" with `pnpm fix`,
`pnpm check`, `pnpm test` and `pnpm test:coverage`. The existing `check` already runs
`cf workers types`, `tsc`, Oxfmt, type-aware Oxlint, the naming and CSS/bundle contracts,
`terraform validate` and `terraform fmt -check`, with no cloud-reaching plan. The 80% gate on all
four metrics across three projects stands, and §6.2 above means the AI path is genuinely coverable
rather than an accepted exception.

## 10. Status

Phase 21 is complete. The model id and its fallback, the gateway schema, the wire shape, the logging
mechanism, the lifecycle guarantee and the docs client are all settled, and the three corrections
above — a better fallback model, an `optional+computed` reclassification in the gateway schema, and
a repository-appropriate logging seam — are recorded rather than carried as folklore. The one
genuinely new finding is §8: this port's `DiagramSession` does not make a server-authored creating
operation replicable, which is latent today and would surface as "the assistant says it connected
everything and the canvas shows no edges" the moment Phase 23 ships. It must be fixed before the
chat depends on it. Every throwaway probe file was deleted after execution and no cloud resource was
touched.
