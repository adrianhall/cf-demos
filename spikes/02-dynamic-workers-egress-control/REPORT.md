# Spike C Report

Run 2026-08-03, entirely against local `wrangler dev`/`@cloudflare/vitest-pool-workers` (both run
the real `workerd` binary — see README.md for why this spike needed no deployment) plus one live
Cloudflare API call to confirm the account's plan tier. Findings below are **live-verified** (an
actual request/response over the local dev server or test pool) or **source-verified** (read
directly from `wrangler types`' generated `worker-configuration.d.ts` — a real, current primary
source). Each finding says which.

## 1. Exact package versions used

| Package | Version | Notes |
| --- | --- | --- |
| `wrangler` | `4.115.0` | pinned, matches every other demo/spike in this repo |
| `@cloudflare/vitest-pool-workers` | `0.19.1` (resolved from `^0.19.0`) | matches `demos/chat` |
| `vitest` | `4.1.10` | matches `demos/chat` |
| `typescript` | `^7.0.2` | matches every other demo/spike in this repo |
| `workerd` (via installed `wrangler`) | `1.20260722.1` | the exact `workerd` binary `wrangler dev` ran against for every live-verified finding below |

## 2. Workers Paid plan prerequisite — confirmed without deploying (live-verified: Cloudflare API)

Spike C's aim asks to confirm the demo account is on a Workers Paid plan (Dynamic Workers'
[current plan requirement](https://developers.cloudflare.com/dynamic-workers/pricing/)). Per
direct operator confirmation, this account has already run other Dynamic Workers projects
successfully, so the plan requirement is satisfied and does not need to be independently proven by
deploying this spike. Separately, `GET /accounts/{account_id}` (the same `CLOUDFLARE_API_TOKEN`/
`CLOUDFLARE_ACCOUNT_ID` from the repo root `.env`) reports this account's `"type"` as `"enterprise"`
— strictly above the Workers Paid tier Dynamic Workers requires, and consistent with this repo's
other demos already using Durable Objects (itself a Workers-Paid-and-above feature). **No blocker
for this demo**; `README.md`'s prerequisites section should still name the Workers Paid plan
requirement for any operator running this demo on a different, lower-tier account, per
docs/06-AGENTIC-CHAT.md's own platform-prerequisite callout.

## 3. `wrangler.jsonc` shape (live-verified: this is what `wrangler dev` actually ran)

```jsonc
{
  "name": "spike-02-dynamic-workers-egress-control",
  "main": "./src/index.ts",
  "compatibility_date": "2026-07-29",
  "worker_loaders": [{ "binding": "LOADER" }],
  "durable_objects": {
    "bindings": [{ "name": "TOOL_RUNNER", "class_name": "ToolRunner" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ToolRunner"] }]
}
```

This matches `docs/06-AGENTIC-CHAT.md`'s prediction: a `worker_loaders` binding declaration plus
the Durable Object binding/migration the `ChatAgent` stand-in (`ToolRunner`) needs. No
`enable_ctx_exports` compatibility flag was needed — confirmed from
`developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-ctxexports`:
`ctx.exports` has been on by default for any `compatibility_date >= 2025-11-17`, well before this
spike's `2026-07-29`. `wrangler dev`'s own binding table confirmed both bindings resolved to
`local` mode with no remote-proxy step at all:

```
Binding                           Resource            Mode
env.TOOL_RUNNER (ToolRunner)      Durable Object      local
env.LOADER                        Worker Loader       local
```

**Finding, confirming README.md's framing**: unlike `env.AI` (Spike A) or D1/KV/R2 remote
bindings, `worker_loaders` has no `remote: true`/`remote: false` option in Wrangler's schema at
all — it is not a proxy to an external account resource, so there is no "remote" mode to opt into.

## 4. A Durable Object can call `env.LOADER.get()` exactly like the top-level `fetch()` handler could (live-verified)

`ToolRunner.runGetUrlTool()` calls `this.env.LOADER.get("get-url-tool", async () => ({...}))` —
the identical shape `developers.cloudflare.com/dynamic-workers/getting-started/` shows for a
top-level `fetch()` handler, with no special-casing needed for being inside a Durable Object.
Confirmed live: `curl "http://localhost:8787/?url=https://example.com/"` returned the real
`https://example.com/` page body (`<!doctype html>...<title>Example Domain</title>...`) with a
`200` status, proving the whole chain — Worker `fetch()` → `ToolRunner` Durable Object →
`env.LOADER.get()` → Dynamic Worker → `globalOutbound` gateway → real network `fetch()` — executed
correctly end to end from inside a Durable Object method.

## 5. `ctx.exports` **is** directly reachable inside a Durable Object method — no threading required (live-verified, corrects an open question)

Spike C's aim explicitly asked whether `ctx.exports` is available from inside a Durable Object
method or must be threaded in from the Worker's own `fetch()` call site — `DurableObjectState`'s
documented API surface (`ctx.storage`/`ctx.id`/`ctx.waitUntil`/`ctx.blockConcurrencyWhile`/...)
does not list `exports` anywhere, so this was a genuine open question, not a formality.

`ToolRunner.runGetUrlTool()` probes this directly: `(this.ctx as unknown as { exports?: unknown
}).exports`. Live result, both for the allow-listed and blocked requests:

```json
{ "ctxExportsAvailableInsideDurableObject": true, "status": 200, "body": "..." }
```

**`this.ctx.exports` is a real, usable object inside a Durable Object method**, not `undefined`
and not a throw. This spike's own design does **not** rely on this — `src/index.ts` still obtains
the `EgressGateway` stub at the Worker's own `fetch()` call site and threads it in as an RPC
parameter, both because that is the pattern
`developers.cloudflare.com/dynamic-workers/usage/egress-control/`'s own example uses and because
it keeps the gateway-construction site (where `props`/per-request scoping would be decided in the
real demo, Section 6.7) next to the code that already has the verified Access identity — but the
finding itself is worth recording: **a future demo phase could call `this.ctx.exports.EgressGateway({})`
directly from inside `ChatAgent`** if there is ever a reason to avoid threading the stub through an
RPC parameter. Update to `docs/06-AGENTIC-CHAT.md` Section 6.7: this either/or question is now
answered — both paths work; threading in from the Worker's own `fetch()` call site remains the
recommended pattern this spike (and Phase 10) uses, for the props-scoping reason above, not
because the alternative is broken.

## 6. `ctx.exports.<Name>()` requires an argument — `ctx.exports.EgressGateway()` alone is a type error (source-verified, corrects the egress-control doc's own example)

`developers.cloudflare.com/dynamic-workers/usage/egress-control/`'s own example calls
`ctx.exports.HttpGateway()` with no arguments. Compiling the identical pattern
(`ctx.exports.EgressGateway()`) against `wrangler types`' generated `worker-configuration.d.ts`
failed with `TS2554: Expected 1 arguments, but got 0`. Reading the generated type directly:

```ts
type LoopbackServiceStub<T> = Fetcher<T> & (opts: { props?: Props }) => Fetcher<T>;
```

The call signature's `opts` parameter itself has no default and is not marked optional — only its
own `props` field is optional. **The correct call is `ctx.exports.EgressGateway({})`** (an empty
options object, when no `props` are needed), not a bare `()`. This spike's `src/index.ts` uses
`ctx.exports.EgressGateway({})`; `tsc --noEmit` passes cleanly with this form. The plain
JavaScript examples in Cloudflare's own docs are not run through a type checker, so this
correction only surfaces in a strict-TypeScript codebase like this repo's — worth flagging for
Phase 10, which will call this pattern from real TypeScript.

## 7. A bare `{ impl: fetch }` seam throws `Illegal invocation` inside workerd — must wrap in an arrow function (live-verified, a real bug this spike hit and fixed)

To make `EgressGateway` unit-testable (Section 9 below), the gateway calls
`networkFetch.impl(request)` instead of the bare global `fetch`, where `networkFetch` is a mutable
`{ impl: typeof fetch }` object a test can swap out. The first version assigned the extracted
function reference directly:

```ts
export const networkFetch: { impl: typeof fetch } = { impl: fetch }; // WRONG
```

Calling `networkFetch.impl(request)` later threw live, for the **allow-listed** host specifically
(the code path that actually reaches this line):

```
✘ [ERROR] Uncaught TypeError: Illegal invocation: function called with incorrect `this` reference.
      at fetch (.../src/egress-gateway.ts:62:25)
```

This is workerd's native `fetch` implementation requiring the global scope as its receiver — see
`developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors`. Extracting
`fetch` as a bare value and storing it on another object loses that implicit receiver. **Fix**:
wrap it in an arrow function so the call site inside the arrow function's own body still invokes
`fetch(request)` with the correct implicit global receiver:

```ts
export const networkFetch: { impl: typeof fetch } = { impl: (request) => fetch(request) }; // correct
```

Confirmed live after the fix: `curl "http://localhost:8787/?url=https://example.com/"` returned
the real page body with a `200`. **This is a real, non-obvious gotcha worth calling out for any
future demo code (Phase 10's real `getUrl` tool, or any other injectable-fetch seam) that stores a
reference to the global `fetch` function on a plain object or class field** — always wrap it in a
closure, never assign the bare reference.

## 8. The allow-list gateway blocks/permits correctly, with both outcomes logged (live-verified)

`wrangler dev`'s own console output for the two `curl` requests in README.md's "Drive it" section:

```
{"msg":"egress-gateway decision","host":"example.com","allowed":true}
{"msg":"egress-gateway decision","host":"cloudflare.com","allowed":false}
```

The allow-listed request (`example.com`) returned the real page body with `200`. The
non-allow-listed request (`cloudflare.com`) never reached `networkFetch.impl` at all — the
Dynamic Worker's own `fetch(target)` call threw inside its `globalOutbound` gateway boundary, and
the tool code's own `catch` turned that into a clean `502` with the gateway's `403` message text
embedded, rather than an uncaught exception or a crashed turn — directly satisfying US-9's
"the agent explains the refusal rather than failing silently or crashing the turn" acceptance
criterion once translated into the real demo's tool-calling loop (Phase 10).

**Finding**: a blocked `globalOutbound` gateway surfaces to the *sandboxed* Dynamic Worker's own
code as a **thrown exception** from its `fetch()` call, not merely a non-2xx `Response` — the
`getUrl` tool's real implementation (Phase 10) must wrap its `fetch()` call in a `try`/`catch`,
exactly as `src/get-url-tool-code.ts` does here, or an agent-side tool call would crash instead of
producing a model-visible refusal explanation.

## 9. Testability: both open questions confirmed live (live-verified — the tests themselves are the finding, per Section 8's "the test is what runs the spike")

**"Whether the gateway itself, independent of `fetch()`, is unit-testable by injecting a fake
`fetch`."** Yes — confirmed by `src/egress-gateway.test.ts`. The seam is the mutable
`networkFetch` object (Section 7): a test cannot *reassign* an imported `const` binding from
another module, but it **can** mutate the object that binding points to
(`networkFetch.impl = fakeFetch`). Both directions were verified: an allow-listed host forwards to
the injected fake and returns its response; a non-allow-listed host is blocked with a `403` and
the injected fake is never called at all (`expect(fakeFetch).not.toHaveBeenCalled()`). Zero real
network traffic in either test.

**"Whether `@cloudflare/vitest-pool-workers` supports `worker_loaders` locally for integration
tests."** Yes — confirmed by `tests/worker-loader.test.ts`, which drives the *entire* real chain
(`ctx.exports.EgressGateway({})` → `ToolRunner` Durable Object → `env.LOADER.get()` → Dynamic
Worker → gateway) inside the test pool's real `workerd` instance, using `import { exports } from
"cloudflare:workers"; await exports.default.fetch(new Request(...))` — the same pattern
`demos/chat/tests/integration/worker.test.ts` already uses to call a Worker's own exported handler
directly inside a test. The test deliberately requests a **non-allow-listed** host so the gateway
blocks the request before any real network `fetch()` happens, per this spike's aim ("a real
network fetch inside a test is undesirable regardless") — the allow-listed, real-network path is
covered once, manually, via `wrangler dev` (Section 4/8 above) instead.

**Two minor, source-verified setup corrections needed to get here**, both fixed in this spike's
`tsconfig.json`/test files and worth carrying into Phase 10's real test suite:

- `tsconfig.json`'s `compilerOptions.types` must include
  `"@cloudflare/vitest-pool-workers/types"` (alongside `"node"`) or `cloudflare:test`/
  `cloudflare:workers` test-only imports (`createExecutionContext`, `env`, `exports`) fail to
  resolve at all (`TS2307: Cannot find module 'cloudflare:test'`) — `demos/chat/tsconfig.json`
  already does this; a fresh spike/demo scaffold must remember to add it too.
- Manually constructing a `WorkerEntrypoint` subclass in a unit test
  (`new EgressGateway(createExecutionContext(), env)`) must pass the **real** `env` object
  imported from `cloudflare:test`, not a bare `{}` — `wrangler types`' generated `Env` interface
  includes every binding declared in `wrangler.jsonc` (`LOADER`, `TOOL_RUNNER` here), so an empty
  object literal fails `tsc --noEmit` with a "missing properties" error against that generated
  type. This is a natural consequence of properly-generated types doing their job, not a spike-only
  workaround — the same rule will apply to any future Phase 10 unit test that instantiates
  `EgressGateway` (or a real demo's own gateway class) directly.

## Follow-ups not covered by this spike

- Whether `env.LOADER.get()`'s caching behavior (a Dynamic Worker "staying warm" across requests,
  per `developers.cloudflare.com/dynamic-workers/getting-started/#reusing-a-dynamic-worker-across-requests`)
  is observable/verifiable from inside a Durable Object across genuinely separate requests to the
  same `ToolRunner` instance — this spike only confirmed the *first-load* path works.
- `props`-based per-request scoping on the `EgressGateway` stub (`ctx.exports.EgressGateway({
  props: {...} })`, per `developers.cloudflare.com/dynamic-workers/usage/egress-control/`'s
  credential-injection example) — this spike's gateway needs no per-request identity, so this was
  not exercised.
- Whether `wrangler deploy`ing this exact code to the real account changes any of these findings
  (Section 2 already establishes no plan-tier blocker exists on this account; this spike otherwise
  never left `localhost`, per README.md's reasoning).
