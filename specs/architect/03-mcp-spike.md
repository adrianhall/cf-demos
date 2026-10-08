# Architect — Phase 11 MCP and Durable Object spike

## 1. Why this report exists

[`02-implementation.md`](./02-implementation.md)'s Phase 11 asks for a written answer to six
questions before any MCP production code is written, because every one of them was settled against a
different toolchain than this port uses. The source design document,
`~/gitlab/cf-demos/docs/09B-ARCHITECT-MCP.md`, was written for a Wrangler-deployed demo, and its own
spike report (`~/gitlab/cf-demos/spikes/07-architect-mcp-spike/REPORT.md`, run 2026-08-10) pinned
`agents@0.20.1` and `@modelcontextprotocol/server@2.0.0`. This port deploys with the `cf` CLI, which
has no Wrangler configuration file at all, and the Agents SDK has published seven minor releases
since that report. Treating either document as settled would carry a Wrangler instruction or a stale
signature into production code.

Everything below was verified today against the versions this repository actually resolves, not
against documentation alone. Where a claim came from running something, the command and its output
are named. Where it came from a document, the document is linked.

## 2. Stateless MCP server mechanism and the versions to pin

### 2.1 The mechanism is confirmed, and the deprecation is now explicit

`createMcpHandler` from `agents/mcp/server`, paired with a server from
`@modelcontextprotocol/server`, remains Cloudflare's current path for a stateless remote MCP server.
The
[MCP handler APIs reference](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
states it directly in its opening table and follows it with "`McpAgent` is deprecated and
feature-frozen", and the
[tools page](https://developers.cloudflare.com/agents/model-context-protocol/protocol/tools/) now
documents `McpAgent` only as something to migrate away from. The source spike's finding stands,
which is worth recording as a negative result: this was the fastest-moving surface in the whole
design, and it has stopped moving.

Stateless is also right for Architect on its own merits rather than by default. Every tool's state
is a D1 row; nothing needs to survive between two MCP requests. The handler's own
[factory lifecycle note](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/#factory-lifecycle)
makes the same point from the other direction — durable application data belongs in D1, KV, R2 or a
Durable Object behind an authenticated handle, never behind an MCP session identifier.

### 2.2 The exact signature, verified against the installed type declarations

The published signature is:

```ts
function createMcpHandler(
  factory: McpServerFactory,
  options?: CreateMcpHandlerOptions
): StatelessMcpHandler;
```

`agents`' own re-export confirms this is a thin alias:
`node_modules/agents/dist/mcp/server/index.d.ts` exports `createStatelessMcpHandler` under the name
`createMcpHandler`, and `CreateStatelessMcpHandlerOptions` under the name `CreateMcpHandlerOptions`.
The returned handler is callable as `(request, env, ctx)` and also carries a
`fetch(request, options?)` method and a `notify` object.

The factory is **not** zero-argument in practice. Its parameter is the per-request context, read
from `@modelcontextprotocol/server`'s own declaration file:

```ts
interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;
  requestInfo?: Request;
}

type McpServerFactory = (
  ctx: McpRequestContext
) => McpServer | Server | Promise<McpServer | Server>;
```

That declaration's own comment names exactly our use case — "the context exists for factories that
vary by principal or era (for example multi-tenant servers keyed off `authInfo`)". Reading the
handler's compiled source (`node_modules/agents/dist/handler-stateless-VvrWSAVA.js`) shows the
factory is invoked once per request, inside `serveModern`, with `requestInfo: request` always set.

### 2.3 How per-request identity reaches a tool, and why we do not use `authInfo`

This is the question Phase 11 singled out, and it deserves a direct answer. The source demo
constructed a fresh handler inside every request to avoid freezing the first caller's identity into
a module-scope singleton, and called the alternative a genuine cross-tenant leak. It was right about
the hazard and wrong about the only available remedy. Current `agents@0.27` gives three mechanisms,
and they are not equivalent:

1. **`options.authContext`**, read by `getMcpAuthContext()` inside a tool handler. The handler runs
   the request inside an `AsyncLocalStorage` scope (`authContextStorage.run(...)` in the compiled
   source), so the value is genuinely per-invocation and not per-isolate. But it is supplied when
   the **handler** is constructed, so using it still forces a handler per request.
2. **`handler.fetch(request, { authInfo })`**, which threads `AuthInfo` through to the factory and
   to every tool handler's `context.http.authInfo` without reconstructing the handler. The
   documentation is explicit that this is pass-through: "the handler never populates this from
   request headers and performs no token verification of its own."
3. **The factory's own `McpRequestContext`**, which carries `requestInfo` — the original `Request` —
   on every call.

**The recommendation is (3), with (2) deliberately unused.** Build the handler **once at module
scope** and derive the caller's identity inside the factory from the verified Access identity the
Hono middleware has already attached, keyed off `ctx.requestInfo`. That is safe for the same reason
the one-handler-per-request dance was thought necessary and is now not: the factory runs per
request, so a server instance — and therefore every tool closure registered on it — is already
scoped to one caller. Nothing identity-shaped is ever stored on the handler.

`authInfo` is the wrong vehicle here specifically because of how Managed OAuth works. Its `AuthInfo`
shape is `{ token, clientId, scopes, ... }` — OAuth client metadata, not a user. Access issues the
MCP client an **opaque** token (`oauth:CvNoo…`), resolves it at the edge, and forwards a signed
`Cf-Access-Jwt-Assertion` header, so from the Worker's perspective "the request looks the same as a
browser-authenticated request"
([Managed OAuth, Token format](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#token-format)).
The user's identity therefore arrives in a header the existing `createAccessMiddleware` already
verifies, and there is no OAuth access token for the Worker to inspect. Populating `authInfo` would
mean inventing a value, and the documentation's warning not to log or return `authInfo.token` is a
good reason not to invent one.

Mounting under Hono rather than as a bare default export changes one more thing. The handler's
wrapper does its own route match and 404s anything whose pathname is not exactly `options.route`, so
Phase 12 must pass `{ route: '/mcp' }` and mount the Hono route at the same literal path. It also
performs Host and Origin validation of its own, and its default allowlist covers only localhost and
`workers.dev` — neither of which is this demo's custom hostname. Phase 12 must therefore set
`allowedHostnames` from the Terraform `hostname` output rather than leaving the default, and must
not hard-code the literal (the naming-contract check would fail it, correctly).

### 2.4 Versions to pin, and a correction the plan did not anticipate

The versions to add are:

| Package                        | Version  | Why this exact value                                     |
| ------------------------------ | -------- | -------------------------------------------------------- |
| `agents`                       | `0.27.0` | Current `latest`; `pnpm view agents dist-tags`.          |
| `@modelcontextprotocol/server` | `2.0.0`  | **Not** the current `2.3.1` — see below.                 |
| `zod`                          | `4.4.3`  | Already a dependency; satisfies `agents`' `^4.0.0` peer. |

The correction is the middle row, and it contradicts the brief given to this phase. `agents@0.27.0`
peer-depends on `@modelcontextprotocol/server` at **exactly `2.0.0`**, not a range:

```
$ pnpm view agents@0.27.0 peerDependencies.@modelcontextprotocol/server
peerDependencies.@modelcontextprotocol/server = '2.0.0'
```

Installing the newest published `2.3.1` alongside it is an unmet peer dependency, confirmed by
installing both into a scratch directory and running `pnpm peers check`, which reported
`unmet peer @modelcontextprotocol/server: Installed 2.3.1, Wanted 2.0.0`. Installing `2.0.0` instead
reported `No peer dependency issues found`, and the same check passes at the repository root after
the real install. The two versions are not interchangeable in a way that would make the warning
cosmetic: the handler's whole contract is the `McpServer` instance the factory returns, and `agents`
re-exports types from the peer it was compiled against.

This is the pin the Cloudflare documentation itself gives
(`pnpm add agents @modelcontextprotocol/server@2.0.0 zod`) with the standing instruction to "use the
exact MCP versions required by your installed Agents release". The repository's own rule about
pinning pre-release and fast-moving packages exactly points the same way. `2.0.0` already carries
the `McpRequestContext` shape §2.2 relies on, verified in its own declaration file, so nothing in
this design needs `2.3.1`.

A smaller install note: `agents` pulls in `core-js-pure` transitively, through the Babel decorator
plugin backing its optional `@callable` Vite transform. pnpm asked for a build decision; it is
denied in `pnpm-workspace.yaml` with a comment, because no demo imports it and its install script
only prints a funding notice.

### 2.5 Bundle impact, measured

Adding the dependencies without importing them leaves the built Worker bundle at 308.28 kB, exactly
as before, and the built-bundle contract test passes unchanged. A throwaway probe that imported
`createMcpHandler` and `McpServer` and re-exported a constructed handler from `src/worker/index.ts`
built successfully for `workerd` and took the bundle to 992.54 kB — so the SDK does bundle cleanly
for the runtime, and Phase 12 should expect roughly 680 kB of Worker-side growth. That is Worker
code, not client code, so it does not touch the client chunk budget the existing contract test
guards. The probe was deleted.

## 3. Access Managed OAuth against the actually-pinned provider

`oauth_configuration` exists on `cloudflare_zero_trust_access_application`, confirmed by running
`terraform providers schema -json` in `cf-terraform-demos/architect/infra` rather than by reading
the registry. The resolved binary is **5.27.0**, not the 5.22.0 the source document assumed; the
constraint is `~> 5.22`, so `.terraform.lock.hcl` has moved up within it. The field set at 5.27.0
is:

| Field                                                | Type           | Notes from the schema                       |
| ---------------------------------------------------- | -------------- | ------------------------------------------- |
| `enabled`                                            | `bool`         | Defaults to `true` when omitted.            |
| `dynamic_client_registration.enabled`                | `bool`         | —                                           |
| `dynamic_client_registration.allow_any_on_localhost` | `bool`         | Any client with a `localhost` redirect URI. |
| `dynamic_client_registration.allow_any_on_loopback`  | `bool`         | Any client with a `127.0.0.1` redirect URI. |
| `dynamic_client_registration.allowed_uris`           | `list(string)` | "Must use the `https` protocol."            |
| `grant.access_token_lifetime`                        | `string`       | Go duration, for example `15m`.             |
| `grant.session_duration`                             | `string`       | Go duration, for example `336h`.            |

The whole attribute is still described as "currently in beta". **Dynamic Client Registration remains
the only registration mechanism**: there is no Client ID Metadata Documents field anywhere in the
schema, five releases after the source spike checked 5.22.0 and found the same. The source spike's
reasoning about why that settles the question is still correct and does not need re-deriving — per
the MCP specification's own client priority order, a client only prefers CIMD when the server
advertises support for it, and Access never does, so even a fully CIMD-migrated client falls back to
DCR against this application.

Two consequences for Phase 12. First, `allowed_uris` cannot narrow an agent harness whose redirect
is a loopback address, because the schema requires `https` and OAuth 2.1's native-app loopback
exception means those clients use plain `http://127.0.0.1:…`; `allow_any_on_loopback` is the only
mechanism that admits them, not a lazier alternative to a tighter rule. Second, the grant shape
Cloudflare recommends for agent clients — a short access-token lifetime with a much longer grant
session — is worth taking as written, because Access re-evaluates policy on every silent refresh, so
a revoked identity loses access within one token lifetime rather than at the next interactive login.

`/mcp*` is already a destination on the `app` application and already an authenticating,
non-redirecting entry in `src/access-policies.ts`, both added in earlier phases with comments
explaining the fail-closed ordering. Phase 12 adds `oauth_configuration` to that same resource and
nothing else: no second application, no second policy.

## 4. Declaring a Durable Object under `cf`

There is no `wrangler.jsonc.tpl` in this repository and there will not be one. Everything the source
document says about `durable_objects.bindings` and a `new_sqlite_classes` migration translates to
two entries in `cloudflare.config.ts`, confirmed against the working `chat` demo and against `cf`'s
own type declarations in `@cloudflare/config@0.20.0`:

```ts
exports: {
  DiagramSession: exports.durableObject({ storage: 'sqlite' })
},
env: {
  DIAGRAM_SESSIONS: bindings.durableObject({
    worker: values.workerName,
    exportName: 'DiagramSession'
  })
}
```

The `exports` entry is what replaces the Wrangler migration. `cf`'s declarations model namespace
lifecycle as a `state` field on the export — `created` (the default), `deleted`, `renamed`,
`transferred`, `expecting-transfer` — rather than as an append-only list of migration tags. That is
a genuine improvement to describe in the demo's documentation: retiring a class is a
`state: 'deleted'` entry rather than a migration whose tag must never be reused, and renaming is
`exports.durableObject({ state: 'renamed', renamedTo: 'NewName' })` with the destination present as
a live entry in the same map. `storage: 'sqlite'` selects the SQLite engine; the legacy key-value
engine has no `ctx.storage.sql` surface at all.

The binding names this same Worker (`worker: values.workerName`), which looks self-referential and
is simply how a Durable Object binding is expressed when the class lives in the binding Worker's own
code. The key must match the class name exported from `src/worker/index.ts` exactly.

Ownership follows from that. The namespace is created by the deploy that uploads the class and
retired when the code stops exporting it, so Terraform must not try to own it — splitting it would
give one resource two owners. `infra/architect.tf` needs no change and no `depends_on` edge. The
`chat` demo's `cloudflare.config.ts` already states this reasoning in a comment and Architect's
should carry the same.

Locally, `cf dev --persist-to .cloudflare/state` keeps Durable Object storage on disk between runs
alongside the simulated D1 database, which `pnpm start` already passes. A `DiagramSession` holding
no durable state of its own has nothing to lose to a wiped state directory, but the flag matters
anyway because the D1 database in the same directory does.

## 5. `elkjs` in `workerd` — re-verified, and it still fails

This was re-tested rather than assumed, with a throwaway probe added to the existing integration
(Workers-runtime) Vitest project, run against real `workerd`, and then deleted. Both of the source
spike's failure modes reproduce exactly, under a newer toolchain than it used —
`workerd 1.20261001.1` by way of `miniflare 5.20261001.0-alpha`, under `cf`/Vite with
`nodejs_compat` enabled, rather than Wrangler 4.120:

- **Default construction.** Importing `elkjs/lib/elk.bundled.js` and calling `new ELK()` throws
  `TypeError: _Worker is not a constructor`, synchronously, before any graph is supplied.
- **Explicit `workerFactory`.** Importing `elkjs/lib/elk-worker.min.js` directly, to supply the
  worker class ourselves, resolves to a **completely empty module** — `Object.keys(module)` is `[]`.

Both were observed at `elkjs@0.12.0`, the version already pinned in this demo and already used by
the browser-side `src/client/lib/auto-layout.ts`. That file's own header comment already states ELK
does not run in `workerd`; this spike is the evidence behind it.

**Phase 13 therefore ships the deterministic grid fallback, and this is now confirmed rather than
contingent.** Sort nodes by a breadth-first traversal from the graph's edges, falling back to node
id for anything unreachable, and place them on a fixed-spacing grid. It needs no new dependency and
is trivially testable because it is pure. The `auto_layout_diagram` tool's MCP description must say
plainly that it produces a simpler grid arrangement than the editor's own auto-layout button, so a
calling model does not promise the user an ELK-quality layout it will not get. That honesty
requirement is the same standard every other tool description in this design is held to.

Deliberately not investigated: whether some other Workers-compatible layout library could produce a
layered result. That is a larger question than "does `elkjs` run", and the grid fallback is
sufficient for this demo.

## 6. Testing hibernatable WebSockets in this repository

The `chat` demo already solves this and Architect should copy its shape rather than rediscover it.
Three rules make such a suite deterministic instead of intermittently hanging, and each exists for a
specific reason:

- **Every test addresses a freshly-named object.** Durable Object storage survives eviction, so a
  reused name leaks one test's state into the next.
- **Every socket is tracked, and `afterEach` calls
  `evictAllDurableObjects({ webSockets: 'close' })`.** Awaiting an outbound close handshake is
  unreliable in this pool even once the server side has closed, so cleanup must not depend on it.
  Eviction is the documented, unconditional way to force every hibernatable socket closed, so a
  failed assertion can never leave a socket open and block the shared runtime from tearing down.
- **An assertion that must prove something did _not_ happen reads storage directly** through
  `runInDurableObject`, rather than racing a message against a timer — the pattern that produces
  intermittent hangs.

`evictDurableObject` and `evictAllDurableObjects` are exported from `cloudflare:test` and both
accept `{ webSockets: 'close' }`; by default a hibernatable socket is hibernated rather than closed,
and eviction waits up to thirty seconds for in-flight requests to drain. Eviction is also the
mechanism for the test that matters most here: evict, reconnect, and assert the object reconstructs
correctly from storage and its socket attachments, which is precisely what happens when a
hibernating session wakes.

`tests/integration/vitest.config.ts` needs three additions. The namespace must be declared to
Miniflare as
`durableObjects: { DIAGRAM_SESSIONS: { className: 'DiagramSession', useSQLite: true } }`.
`fileParallelism: false` must be set, because test files share one `workerd` runtime and running
them concurrently starves hibernatable WebSocket delivery in this pool. And `hookTimeout` must be
set alongside the `testTimeout: 10_000` the file already has, because a teardown hook that hangs
stalls an entire file rather than failing one test; `chat` uses `15_000`. The repository rule that
every integration project declares a finite timeout is already satisfied, and these additions extend
it to the hook.

Coverage needs no new machinery. The existing Istanbul configuration already covers `src/**` at an
80% floor on all four metrics, and a Durable Object class exercised through the real route is
instrumented like any other module.

## 7. What Phases 12–15 must do differently from the source document

Concretely, and in the order the phases run:

1. **Pin `@modelcontextprotocol/server@2.0.0`, not the newest release.** `agents@0.27.0` peer-pins
   it exactly (§2.4). Phase 12 must not "helpfully" upgrade it, and a future dependency bump must
   move both packages together after re-checking the peer range.
2. **Build the handler once at module scope and scope identity through the factory's
   `McpRequestContext`** (§2.3). The source document's per-request handler construction is no longer
   necessary, and `authInfo` is the wrong vehicle because Managed OAuth hands the Worker a verified
   Access header rather than an inspectable token.
3. **Pass `route: '/mcp'` and an `allowedHostnames` derived from the Terraform `hostname` output.**
   The handler 404s a pathname that is not exactly its configured route and its default Host
   allowlist does not include a custom domain. Neither value may be written as a literal.
4. **Add `/mcp*` to `runWorkerFirst` in `cloudflare.config.ts`, not to a Wrangler file.** The field
   is `assets.runWorkerFirst`, typed as `string[] | boolean`, and it takes glob patterns where `*`
   matches deeply and a `!` prefix negates. `/mcp` is not under the existing `/api/*`, so without
   its own entry every MCP request falls through to the single-page-application asset fallback and
   404s.
5. **Declare `DiagramSession` through `cf`'s `exports`/`bindings`, not `new_sqlite_classes`** (§4).
   Every sentence in the source document about `wrangler.jsonc.tpl`, `durable_objects.bindings` and
   migration tags is void here. Terraform still owns nothing of the namespace, for the same reason
   it did there.
6. **Put the live-sync upgrade route under `/api/`, where Access and `runWorkerFirst` already cover
   it.** `GET /api/diagrams/:id/live` needs no new Access entry and no new asset rule — a deliberate
   benefit of the existing path-prefix design, and the same choice `chat` made.
7. **Follow the repository's own WebSocket and Durable Object rules, which are stricter than the
   source document's.** Forward the caller's upgrade request; scrub and set the verified identity in
   one named function so the deletion and assignment cannot be half-performed; pin identity with
   `serializeAttachment()` and read the author back from the attachment, never from a frame; answer
   a non-upgrade request with `426 Upgrade Required` through `upgradeRequired()` from
   `@demos/worker-common`, not `400`; and test a smuggled identity header at both the unit level
   (including a differently-cased spelling) and in the Workers-runtime suite. The source document
   specifies none of these, and the chat demo already demonstrates all of them.
8. **Ship the grid auto-layout and say so in the tool description** (§5). Confirmed, not contingent.
9. **Use `@demos/worker-common` and the toolkit rather than hand-rolling.** Identity comes from
   `currentIdentityEmail()`; a JSON body goes through `jsonBodyLimit()` and `readJsonBody()`; errors
   are RFC 9457 problem details. The source document predates both libraries and describes
   hand-written equivalents.
10. **Expect the `enforceSameOriginJson` middleware to reject an MCP client, and decide
    deliberately.** `POST /mcp` is state-changing with a JSON body, and the middleware rejects a
    request carrying neither `Origin` nor `Sec-Fetch-Site` precisely because a legitimate
    same-origin browser `fetch` always sends one. An MCP client is not a browser and sends neither.
    Phase 12 must carve `/mcp` out explicitly, with a comment explaining that its CSRF reasoning
    does not apply to a bearer-authenticated non-browser caller, and must assert that carve-out in a
    test. The source document does not mention this at all, and it would otherwise surface as every
    tool call failing with a `403` that looks like an Access problem.
11. **Drop the `terraform plan` re-verification step from Phase 12's text.** It contacts the real
    account; `terraform validate` and `terraform fmt -check` are what `pnpm check` runs and what
    this repository's rules require.
12. **Treat the live Managed OAuth round trip as the one manual step.** It cannot be emulated
    locally, because it is an Access-edge feature; local development exercises `/mcp` with a
    development JWT through the same policy list. Phase 15 owns the deployed smoke check, as the
    source document also concluded.

## 8. Status

Every Phase 11 question has an answer above, backed by a command that was run or a document that was
read today. The dependencies are installed and pinned, `pnpm check` passes, and the built Worker
bundle is byte-for-byte unaffected because nothing imports them yet. Both throwaway probes — the
`elkjs` construction test and the bundle-growth test — have been deleted. Phase 12 may begin.
