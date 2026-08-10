# Report — `docs/09B-ARCHITECT-MCP.md` Phase 11 spike

Run/researched 2026-08-10. See `README.md` for the four questions this answers.

## 1–2. Stateless MCP server mechanism: `createMcpHandler` confirmed, not corrected

**Finding: `createMcpHandler` from `agents/mcp/server`, paired with `@modelcontextprotocol/server`,
is Cloudflare's current, blessed mechanism for a stateless remote MCP server — exactly what
`docs/09B-ARCHITECT-MCP.md` already specifies. No scope change to that document.**

Evidence, across the three sources Phase 11 named:

- **Cloudflare blog.** [_The next generation of
  MCP_](https://blog.cloudflare.com/mcp-v2/) (Matt Carey, 2026-08-06 — the most recent post
  tagged `mcp` on `blog.cloudflare.com` as of this spike) is exactly the transition-announcement
  post the Spike Conventions predicted: it announces the MCP **2026-07-28** specification (fully
  stateless core, no `Mcp-Session-Id`, no required `initialize` handshake) and states plainly that
  `createMcpHandler` — introduced experimentally in the Agents SDK in November 2025 — has now
  **"graduate[d] into the official MCP TypeScript SDK"** with this release. The post explicitly
  says the new spec **"removes the need for `McpAgent`"** and that Durable Objects remain the
  right primitive only when "an application itself needs state" (not for MCP protocol state
  itself) — directly validating `docs/09B-ARCHITECT-MCP.md`'s own reasoning for why
  `DiagramSession` is justified (live-sync fan-out, a real coordination need) while the MCP server
  itself is stateless.
- **`github.com/cloudflare` repositories.** `cloudflare/agents`' own
  [`examples/mcp-worker`](https://github.com/cloudflare/agents/tree/main/examples/mcp-worker)
  (the org's canonical, current example, not `examples/mcp` which is explicitly the **legacy**
  `McpAgent`/Durable Object counterpart per that same repo's example index) uses the identical
  `createMcpHandler(createServer)(request, env, ctx)` shape this document already specifies,
  confirming the pattern against a maintained first-party example, not just prose docs.
- **`@cloudflare` npm scope.** Searched `npmjs.com/org/cloudflare` for any MCP-specific package
  that might supersede going through the community-namespaced `@modelcontextprotocol/*` packages
  directly. Found `@cloudflare/mcp-server-cloudflare` (a client-facing MCP server *for calling
  Cloudflare's own API*, last published over a year ago against MCP SDK `^0.6.0` — unrelated to
  building a first-party MCP server on Workers) and `@cloudflare/workers-oauth-provider` (current,
  actively maintained — see the OAuth note below). Neither supersedes
  `agents`/`@modelcontextprotocol/server` for this document's use case. Current published
  versions confirmed via `npm view`: `agents@0.20.1`, `@modelcontextprotocol/server@2.0.0`,
  `@modelcontextprotocol/sdk@1.30.0` — all consistent with the docs' stated dependency versions
  (`npm i agents @modelcontextprotocol/server@2.0.0 zod`).

Current docs cross-checked and consistent with the above:
[MCP handler APIs](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
(`createMcpHandler` vs. the deprecated `createLegacyMcpHandler`/`McpAgent`),
[`McpAgent` reference](https://developers.cloudflare.com/agents/model-context-protocol/apis/agent-api/)
(explicitly "Deprecated... feature-frozen"), and the
[SDK v2 migration guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/).

**One caveat investigated in depth, and it resolves cleanly — not a scope change, and not merely a
client-readiness question either:** the same blog post notes MCP authorization is also evolving —
the spec now "prefers pre-registered clients... then [Client ID Metadata Documents (CIMD)]... with
Dynamic Client Registration (DCR) as a fallback. **DCR is deprecated for new implementations**"
(removal after summer 2027). Whether that mattered here turned into a three-part question, each
checked independently:

1. **Is any real agentic harness already CIMD-first in production, making this an active migration
   rather than a hypothetical?** Yes — confirmed via a real, dated bug report:
   [`anthropics/claude-code#84263`](https://github.com/anthropics/claude-code/issues/84263)
   (opened 2026-08-05) describes Claude Code authenticating to MCP servers with the URL-shaped
   client id `https://claude.ai/oauth/claude-code-client-metadata` (CIMD), including a real
   operational failure mode (Cloudflare's own bot protection 403ing some cloud egress IPs' fetches
   of that document). Claude Code has already fully migrated.
2. **Has OpenCode?** No — and this part genuinely is a latent gap, not a settled non-issue.
   OpenCode's bundled `@modelcontextprotocol/sdk` already contains generic CIMD-detection logic
   (checks `client_id_metadata_document_supported` in server metadata; uses a `clientMetadataUrl`
   property from the supplied `OAuthClientProvider` if present — see the SDK's `auth()` helper,
   found in the same binary). But OpenCode's own custom provider class (the `T2` class this report
   already inspected for question 4) never sets `clientMetadataUrl`, so that code path is
   currently dead weight — OpenCode always falls through to DCR today. This is exactly the
   "bug when they eventually deprecate it" scenario: the mechanism already exists one layer down,
   unused, with no indication OpenCode's own configuration will pick it up before DCR support is
   pulled from clients upstream.
3. **Would enabling CIMD on this demo's Access application even be possible today, regardless of
   client readiness?** No — checked directly against both the pinned Terraform provider schema
   (`terraform providers schema -json` against the cached `cloudflare/cloudflare` `5.22.0` binary)
   and the live [Access applications API
   reference](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/):
   `oauth_configuration` has exactly three fields — `enabled`, `dynamic_client_registration`,
   `grant` — no CIMD equivalent, and the entire feature is explicitly labeled **Beta**. Access
   never advertises `client_id_metadata_document_supported: true` in its OAuth server metadata.

   **This third finding is what actually settles the question, and it out-ranks the first two**:
   per the MCP spec's own client priority order (pre-registered → CIMD *only if the server
   advertises it* → DCR fallback → user prompt), **even a fully CIMD-migrated client like Claude
   Code will use DCR against this demo**, because Access itself gives it no CIMD path to prefer.
   Whether OpenCode personally has or hasn't wired up `clientMetadataUrl` is moot for this
   specific demo today — the ceiling is on Cloudflare's side, not the client's.

**Decision: no scope change, and this is not deferred client-readiness work — it is currently
impossible to do differently.** `dynamic_client_registration.enabled = true` remains the only
mechanism Access's (still-Beta) Managed OAuth offers, for any client, full stop. What *is* worth
tracking going forward, independent of this document: if MCP client implementations broadly drop
DCR support before Cloudflare ships CIMD support on Access, every Access-fronted MCP server (not
just this one) loses its non-browser auth path — that is an external, Cloudflare-side dependency
to watch, not a design gap in Demo 9B to fix preemptively.

Also confirmed, useful context not previously in the document: Cloudflare's [Secure MCP
servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
doc's two documented setups ("customer-managed third-party" and "SaaS-managed third-party") are
both about **third-party** MCP server code that already handles its own OAuth flow — neither
applies here. The actually-applicable path is the separate [Managed
OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
doc's "Enable managed OAuth on an MCP server application" section, which explicitly covers
first-party MCP server code on a self-hosted Access application that validates the
`Cf-Access-Jwt-Assertion` header itself — exactly `docs/09B-ARCHITECT-MCP.md`'s design. No
correction needed, but this is the more precise doc to cite from that document's Access Model
section (in addition to the Managed OAuth page it already cites).

## 3. `elkjs` does **not** run inside `workerd` — confirmed, and this is a correction

**Finding: `elkjs` (all reasonably-attempted entry points and workarounds) throws synchronously
when constructed inside `workerd`. `docs/09B-ARCHITECT-MCP.md`'s planned `autoLayout()` MCP tool
must ship the deterministic grid-placement fallback that document already named as its own
contingency for exactly this outcome — this is not optional follow-up work, it is now the
confirmed path.**

Two independent attempts, both reproduced by `tests/` in this spike directory, run against a real
local `workerd` instance via `@cloudflare/vitest-pool-workers` (not a mock):

1. **Default construction**, mirroring `demos/architect`'s own real client-side
   `applyAutoLayout()` code (`elkjs/lib/elk.bundled.js`, `new ELK()`, `layered`/`ORTHOGONAL`
   layout options): `new ELK()` throws `TypeError: _Worker is not a constructor` immediately,
   before any graph is ever supplied. Root cause: `elk.bundled.js` is not actually a browser-safe
   bundle despite its name — elkjs's own `package.json` build script browserifies
   `build/js/main-node.js` (the **Node**-targeted entry point) into `lib/elk.bundled.js`. That
   Node entry point's `ELKNode` class does its own internal
   `require('./elk-worker.min.js')` to obtain a synchronous "fake worker" class it uses as a
   default `workerFactory`. Once Wrangler/esbuild re-bundles this already-browserify-bundled file
   a second time for `workerd`, that nested `require()` call resolves to an object with no usable
   `Worker` property.
2. **Explicit `workerFactory`**, to see whether bypassing elkjs's own internal `require()` (by
   importing `elkjs/lib/elk-worker.min.js` directly, ourselves, as a top-level ES module, and
   passing its `Worker` export straight into `new ELK({ workerFactory })`) sidesteps the failure.
   It does not, for an independent reason: importing `elkjs/lib/elk-worker.min.js` directly
   resolves to a **completely empty module** (`Object.keys(...)` is `[]`) once bundled for
   `workerd`. That file is a large GWT (Google Web Toolkit, Java-compiled-to-JS) blob whose
   `module.exports = { default, Worker }` assignment sits behind the file's own environment
   feature-detection (`typeof window` / `typeof global` / `typeof self`) and several layers of
   closure nesting; something in that combination never reaches the export assignment once
   re-bundled for `workerd`, with or without the `nodejs_compat` compatibility flag (tried both;
   identical failures either way — see `wrangler.jsonc`'s comment).

Both failure modes were confirmed against `elkjs@0.12.0` — the exact version already pinned in
`demos/architect/package.json` — with Wrangler `4.120.0` / the `workerd` release it bundles
(`workerd@1.20260801.1`-class; the actual local run used the closest release the installed
`wrangler` ships, `1.20260808.0` per the `compatibility_date` this spike had to use — see
`wrangler.jsonc`).

**What this means for `docs/09B-ARCHITECT-MCP.md`:** its [Shared Graph Mutation
Service](../../docs/09B-ARCHITECT-MCP.md#shared-graph-mutation-service) table's `autoLayout()` row
already named the fallback path ("If it cannot [run unmodified], ship a simple deterministic
grid-placement fallback instead and record the finding in `docs/DECISIONS.md`, exactly as Demo 9's
own spike reports record such corrections"). Per this spike's finding, that fallback is now the
**confirmed, required** implementation, not a contingency to re-evaluate in Phase 13. A reasonable
grid fallback: sort nodes by their existing `id` (or by a simple breadth-first traversal from
edges, to approximate layering) and place them on a fixed-spacing grid — deterministic, fast, and
needs no additional dependency. Phase 13's `auto_layout_diagram` MCP tool description should say
plainly that it produces a simpler grid arrangement, not `elkjs`'s layered algorithm, so a model
calling it does not over-promise the result to the user (matching this document's own stated
tools-description-honesty standard).

**Not investigated further, and deliberately out of this spike's scope:** whether a from-scratch,
Workers-compatible layout library (not `elkjs`) exists that could replace the grid fallback with
something layered-looking. That is a distinct, larger research question than "does `elkjs` run
unmodified," and `docs/09B-ARCHITECT-MCP.md` did not ask for it — the grid fallback is sufficient
for this demo's MVP scope.

## 4. OpenCode's MCP OAuth client: fixed default redirect, DCR (not CIMD), RFC 8707 + PKCE

**Finding: OpenCode's MCP OAuth client uses a fixed, well-known default redirect URI —
`http://127.0.0.1:19876/mcp/oauth/callback` — confirms it needs `allow_any_on_loopback` (not a
narrower `allowed_uris` entry, which cannot work here — see below), still performs plain Dynamic
Client Registration (not the newer CIMD path), and does send the RFC 8707 `resource` parameter
Managed OAuth requires.**

Determined by inspecting OpenCode's own compiled CLI binary (`opencode@1.18.15`, the version
installed in this environment; `strings` extraction of `~/.opencode/bin/opencode`, a Bun-compiled
executable with unminified-enough symbol names to read the actual OAuth client class) alongside
OpenCode's published docs
([MCP servers](https://opencode.ai/docs/mcp-servers/)):

- **Default callback port and path are hardcoded constants**: `19876` and
  `/mcp/oauth/callback`. The client's `redirectUrl` getter is exactly:
  `` config.redirectUri ?? `http://127.0.0.1:${config.callbackPort ?? 19876}/mcp/oauth/callback` ``
  — i.e. a project's `opencode.json` can override either the port
  (`mcp.<name>.oauth.callbackPort`) or the whole redirect URI
  (`mcp.<name>.oauth.redirectUri`), but **the un-configured default is this fixed value**, not a
  randomly-chosen ephemeral port per run. The local callback HTTP server itself binds literally to
  `127.0.0.1` (not `0.0.0.0` or `localhost`), confirmed from the same binary
  (`createServer(...).listen(port, "127.0.0.1", ...)`).
- **This confirms, rather than narrows, `docs/09B-ARCHITECT-MCP.md`'s existing
  `allow_any_on_loopback: true` choice** — and clarifies *why* the document's own suggested
  alternative ("narrow... to an explicit `allowed_uris` entry instead if the client's redirect URI
  is stable enough to allow-list directly") **cannot actually be used here**: Cloudflare's Managed
  OAuth `allowed_uris` field requires an `https://` URL ("The URL must use `https`" — [Managed
  OAuth
  settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings)),
  and OpenCode's redirect is, correctly per OAuth 2.1's native-app loopback exception, plain
  `http://127.0.0.1:.../...`. There is no way to allow-list a specific `http://127.0.0.1:PORT` URI
  through `allowed_uris`; `allow_any_on_loopback` is not a fallback choice here, it is the **only**
  mechanism that can admit this client at all. `docs/09B-ARCHITECT-MCP.md`'s Access Model section
  should drop the "narrow to `allowed_uris` instead" framing as a live option for OpenCode
  specifically (it can remain accurate general advice for a *different*, https-redirect client).
- **Client registration**: OpenCode's `clientMetadata` sent during Dynamic Client Registration is
  `{ redirect_uris: [redirectUrl], client_name: "OpenCode", client_uri: "https://opencode.ai",
  grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "none" }` (a public client — no client secret — unless the operator
  configures one manually via `mcp.<name>.oauth.clientId`/`clientSecret` in `opencode.json`, the
  "Pre-registered" path OpenCode's own docs describe). This is plain **RFC 7591 Dynamic Client
  Registration**, matching `docs/09B-ARCHITECT-MCP.md`'s
  `oauth_configuration.dynamic_client_registration.enabled = true` — OpenCode does not yet speak
  the newer Client ID Metadata Documents mechanism the MCP 2026-07-28 spec now prefers (see
  question 1–2's caveat above), so DCR remains the correct, necessary setting for this client
  today.
- **PKCE and RFC 8707 confirmed in use**: the same binary contains `code_challenge`,
  `code_challenge_method`, and `codeVerifier` handling (PKCE, required by OAuth 2.1), and sends a
  `resource=` parameter on the authorization/token requests (RFC 8707 resource indicators) —
  satisfying Managed OAuth's stated prerequisite, "An OAuth client that supports RFC 8707."
- **Protocol version**: the same binary's bundled MCP client SDK recognizes protocol version
  strings `2025-03-26`, `2025-06-18`, and `2026-07-28` — confirming OpenCode already speaks the
  new stateless MCP 2026-07-28 protocol a `createMcpHandler` server uses, not just legacy
  Streamable HTTP.
- **Operator-visible commands**, from OpenCode's published docs, worth citing directly in
  `docs/09B-ARCHITECT-MCP.md`'s Phase 15 `DEMO.md` script: `opencode mcp auth <server-name>` to
  manually trigger the browser login, `opencode mcp list` to see auth status per server, and
  `opencode mcp debug <server-name>` to diagnose a failed OAuth discovery/connection round-trip —
  more useful for a live demo's troubleshooting than generic "the client should open a browser
  window" phrasing.

**What this means for `docs/09B-ARCHITECT-MCP.md`:** no change to the `oauth_configuration` block
itself (`allow_any_on_loopback: true`/`allow_any_on_localhost: true` remain correct and, per the
above, are not optional). Two small documentation improvements worth making in that document:
(a) replace the "narrow to `allowed_uris` instead" suggestion with a note that this specific
narrowing is not available for a loopback-redirect client like OpenCode's, so a future reader does
not spend time trying it; (b) cite the exact default redirect (`http://127.0.0.1:19876/mcp/oauth/callback`)
so `DEMO.md`'s presenter script can state plainly what a presenter will see requested during the
Managed OAuth browser prompt.

**Scope boundary, deliberately not closed by this spike**: Phase 11's item 4 also asks to verify
this "end-to-end on a scratch Access application" — an actual deployed Worker and Access
application on the real Cloudflare account, with a live browser OAuth round trip. This spike
answers everything about the *client's* behavior from static analysis (sufficient to configure the
Access application correctly the first time), but does not perform that live deploy-and-log-in
check, per this repository's standing rule against touching real account infrastructure without
explicit request. **This remains an open, manual pre-Phase-12 verification step** — deploy the
scratch Access application from `docs/09B-ARCHITECT-MCP.md`'s own `oauth_configuration` snippet,
front a minimal `createMcpHandler` Worker with it, and run `opencode mcp auth <name>` against the
deployed hostname to confirm the real round trip matches this report's predictions, before
treating Phase 11 as fully closed. This mirrors the document's own Phase 15 precedent of treating
a real OAuth round trip as a manual smoke check rather than an automatable one.

## Definition of done

Per `docs/09B-ARCHITECT-MCP.md`'s Phase 11: every open question above has a written answer here
and is now also recorded in `docs/DECISIONS.md` under "NEW DECISIONS." The auto-layout fallback
path (grid placement, not `elkjs`) is chosen and does not need re-evaluating before Phase 13
starts. Question 4's real-account, end-to-end OAuth round trip (as opposed to the client-behavior
research this report completes) is intentionally left as the one remaining manual step before
Phase 11 is fully closed — see the "Scope boundary" note above.
