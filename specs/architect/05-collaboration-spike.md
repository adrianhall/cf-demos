# Architect — Phase 16 collaboration and Durable Object spike

## 1. Why this report exists

[`02-implementation.md`](./02-implementation.md)'s Phase 16 deliberately stops before changing
production collaboration behaviour. The source collaboration design,
`~/gitlab/cf-demos/docs/09C-COLLABORATIVE-EDITING.md`, was written for a Wrangler deployment and
its companion spike (`~/gitlab/cf-demos/spikes/08-architect-collab-race/REPORT.md`) used an older,
differently-shaped `DiagramSession`. Architect now deploys through `cf` plus Terraform, already has
a one-way hibernatable `DiagramSession`, and runs its integration suite through
`@cloudflare/vitest-plugin` against `workerd`. It would be unsafe to treat either source document
as an executable statement about this project without checking the current platform and this actual
toolchain.

Everything below was rechecked on 2026-10-09. Documentation findings were retrieved from current
Cloudflare documentation. Runtime findings came from throwaway integration probes registered in the
same `tests/integration/vitest.config.ts` Workers pool as
[`live-sync.test.ts`](../../cf-terraform-demos/architect/tests/integration/live-sync.test.ts), then
deleted. No Worker, database, Terraform state, or other cloud resource was changed.

The broad collaboration direction remains sound: one `DiagramSession` addressed by diagram id is
the right coordination atom, and D1 remains the diagram's only durable copy. The probes do correct
one claimed property of the source spike: a write chain makes the **final** durable value ordered and
correct, but reading the in-memory graph inside a chain link does not make every intermediate write
already-current if that link itself awaits a slow external D1 write. Phase 18 must not claim that it
does.

## 2. The platform behaviours the design depends on

### 2.1 Class fields are disposable, including after an uncaught exception

The current [Durable Object Lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
states explicitly that, when an object hibernates, “the in-memory state is discarded”; a later event
runs the constructor again. The current [WebSockets and hibernation guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
repeats the same operational fact in the form relevant to Architect: while the object is evicted,
hibernatable WebSocket clients remain connected at Cloudflare's edge, in-memory state is reset, and
the constructor runs when an event wakes the object. The [in-memory-state reference](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
also says class variables last only while the object remains in memory.

The Phase 16 eviction probe confirmed this in the actual Workers test pool. It wrote an in-memory
probe graph, called `evictDurableObject()`, then addressed the same named object again. The next
instance had empty graph, sequence, trace, and simulated-persistence fields. That is why Phase 18's
working graph and sequence are cache/session state only, why graph hydration must happen before an
operation uses them, and why socket identity belongs in a serialized attachment rather than an
instance map.

The current [Rules of Durable Objects guide](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-the-difference-between-in-memory-state-and-persistent-storage)
adds the case the source spike correctly called out: in-memory class properties are lost not only on
inactivity eviction but also “if it crashes from an uncaught exception.” Its caution immediately
below says the runtime may terminate the instance after an uncaught exception and that its in-memory
state is then lost while durable storage remains intact. This matters even though D1 protects the
graph: an uncaught Phase 18 mutation/persist error would discard a hot cache and leave connected
clients depending on a cold rehydration path unnecessarily.

The throwaway probe also exposed an important test distinction. An RPC method which throws is
reported to the caller in this `workerd` pool, but the immediately following RPC invocation still
observed the same resident class fields; that is not evidence against the documented crash case. It
only shows that a request failure delivered through this test RPC transport did not force an
immediate isolate termination. The documentation is the authority for a runtime-terminating
uncaught exception, and Phase 18 must handle more than the expected `notFound()` stale-target case:
it should turn every anticipated domain validation/mutation failure into an
`operation_rejected` frame and, critically, keep the write-chain tail recoverable after a storage
failure instead of leaving a rejected promise to poison every later operation.

### 2.2 The input gate protects a synchronous mutation, and opens at `await`

The current [Rules of Durable Objects input/output-gates section](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work)
says that a Durable Object is single-threaded, that synchronous JavaScript blocks new incoming
events through the input gate, and that awaiting asynchronous work such as `fetch()` or KV opens
that gate and permits interleaving. The same page separately warns that non-storage I/O permits
interleaving. This is the precise, current basis for the design; “single-threaded” must not be read
as “an entire async method is atomic.”

The distinction is load-bearing. Two operations' mutation steps cannot interleave if each operation
reads the working graph, calculates the replacement, assigns it, increments its sequence, and
queues its persist without an `await` in that interval. Once the first handler awaits its queued
write turn, the input gate is open. A second operation can then run **its own complete synchronous
mutation step** before the first operation's persist promise resolves. That is intended: it lets the
object accept later edits while the first D1 write waits. What cannot happen is a second operation
in the middle of the first operation's synchronous read-modify-replace interval.

The probe made the negative case observable. Two simultaneous operations with an artificial
non-storage `await` between reading and incrementing a sequence field both returned sequence `1` on
all five runs: each read the old value, yielded, then overwrote the other increment. Removing that
`await` produced distinct sequence values `1` and `2` every time. The asynchronous boundary, not
the identity of a WebSocket or RPC transport, is where the gate opens.

## 3. Race and write-chain probes in this repository's `workerd` suite

### 3.1 Conflicting concurrent operations reached one object and neither vanished

A throwaway `ProbeSession` Durable Object was declared only in the integration Miniflare
configuration and exported only for the probe run. It held an in-memory `Record<nodeId, value>`, a
sequence counter, an applied-operation log, and a simulated external persist. Five times, the test
dispatched `applyOperation('shared-node', 'a')` and
`applyOperation('shared-node', 'b')` without awaiting between the calls. This is the Phase 18
shape: each operation synchronously changes the working graph and enqueues a persist, then awaits
its own completion.

Every run produced distinct synchronous sequences `[1, 2]`, two log entries in that same order, and
final in-memory and simulated durable values of `b`, the second applied operation. Thus exactly one
operation deterministically won the same-node conflict under the documented last-applied-wins rule,
and both operations were observed as applied rather than one being silently dropped. A companion
probe that targeted two different node ids left both values present in memory and in the final
persisted map.

The deterministic winner here is the operation whose **synchronous mutation step** receives the
second sequence number, not whichever client-side promise happens to resolve last. The test run
consistently delivered A then B, so B won; production must document that arrival/application order,
not browser clock order, resolves a same-target conflict.

### 3.2 The deliberately broken implementation really loses the final durable update

The counter-example used exactly the requested adversarial ordering: A was dispatched first with a
50 ms simulated persist delay; B followed immediately with no delay. The deliberately unchained
implementation captured each graph snapshot and persisted it independently. Its trace was:

```text
sync:a, sync:b, persist:b->b, persist:a->a
```

The in-memory graph correctly ended at `b`, but the final simulated D1 value was `a`: slow A wrote
its old captured snapshot after fast B had already persisted the newer one. The test would fail
against the intentionally broken implementation, so it has the discriminating power the phase
requires. This is why Phase 18 needs one ordered per-object persistence path rather than merely
relying on a single active JavaScript instance.

With the chained implementation, the same two-operation adversarial case produced:

```text
sync:a, sync:b, persist:a->a, persist:b->b
```

and final in-memory and persisted values of `b`. The chain is the essential part of the final-value
proof: strict links prevent a slow earlier external write from completing after a later link.

### 3.3 Correction: “fresh read” helps, but the source report overstates what it proves

The source design correctly asks each write-chain callback to read `this.graph` when its turn begins
rather than capture a graph value while enqueuing. That is useful: in a three-operation probe where
A and B were queued, C changed the graph while A was still delayed, the fresh-read chain wrote
history `[a, c, c]`, while the capture-at-enqueue chain wrote `[a, b, c]`. With a deliberately slow
C as well, polling observed the capture-at-enqueue path expose the durable sequence
`null → a → b → c`, whereas fresh reads exposed `null → a → c`. A queued B link therefore need not
write an already-obsolete B snapshot after C has been synchronously applied.

However, the probe also disproves a stronger source-spike sentence: fresh reads do **not** mean an
older first link can never persist a stale value at all. The first link begins before B's synchronous
mutation is delivered, reads `a`, awaits its slow external D1 write, and then writes `a`; after that
the ordered B link writes `b`. The final durable value is correct, but an observer of D1 during the
operation can see `a`. This does not create the feared final clobber, because B's link is ordered
after A, but it means Phase 18 must phrase the guarantee honestly: **the chain gives final
last-applied-wins persistence; reading fresh graph state at link start coalesces later queued writes
toward the newest known graph, but it cannot retroactively change a write already in flight.**

That also refines the requirement that “both halves are necessary.” They serve different guarantees:
strict ordering is necessary for the final durable order; a fresh read at link start is necessary to
avoid needless stale intermediate writes by links that have not started yet. A chain which captures
at enqueue still ended at the latest operation in the tested finite sequence, but wrote more stale
intermediates. Conversely, the unchained counter-example final-clobbered. Phase 18 should retain
both properties, test both effects separately, and never advertise the fresh read as an atomic
snapshot-at-write-completion mechanism.

One further failure was discovered while probing error paths. Assigning a rejected persist promise
straight to `this.writeChain` caused every later `.then()` link to reject with the same earlier
failure; later mutations changed the in-memory graph but none could persist. Phase 18 must keep a
caught tail for sequencing (for example, assign `turn.catch(...)` to the tail while returning or
reporting the original `turn` to its own caller) and must make an explicit decision about how a
failed persist is represented to the originator. An uncaught rejection is not only a cache-loss risk;
it can permanently poison the session's write path until eviction.

## 4. Multi-client support in the configured integration project

The current `tests/integration/vitest.config.ts` already has the three controls Phase 13 established
for hibernatable Durable Objects: `DIAGRAM_SESSIONS` is declared as SQLite-backed,
`fileParallelism: false` serializes files sharing the `workerd` runtime,
`testTimeout: 10_000` and `hookTimeout: 15_000` are finite, and the live-sync suite calls
`evictAllDurableObjects({ webSockets: 'close' })` in `afterEach`. No configuration change is needed
for Phase 16 or Phase 18 merely to support multiple simultaneous clients.

A throwaway integration test opened four real hibernatable client sockets to the same actual
`DiagramSession`, installed all four frame listeners before triggering its typed RPC fan-out, and
received all four `graph_updated` frames. A separate run confirmed the present Phase 13 policy
allows two sockets authenticated as the same owner and rejects a different identity with the
expected non-enumerating `404`; the latter is the intentional Phase 17 authorization gap, not a
limitation of multi-client simulation. After Phase 17 creates a collaborator row, the same fixture
shape can open one socket as owner and one as collaborator.

The Phase 13 response-body trap was reproduced exactly. A direct `stub.fetch()` returning the
session's deliberate `400` response was asserted without consuming its body. The following
`afterEach` eviction waited on that in-flight response and exceeded the configured 15-second hook
timeout; a direct standalone measurement then failed after the runtime's approximately 30-second
eviction wait with “Timed out waiting to evict Durable Object: it still has active references.” The
identical request followed by `await response.text()` let eviction finish in 0–1 ms. Every integration
test that receives a response body, including error responses, must consume it before teardown.
This is why the existing direct-session test drains its `400` body, and why future socket/race
fixtures must do the same.

## 5. Concrete implementation deltas for Phases 17–20

### 5.1 Deployment, D1 migration, and infrastructure ownership

`09C-COLLABORATIVE-EDITING.md` says `diagram_collaborators` arrives in a Wrangler-run migration
and refers to `db:migrate:*` scripts. Neither applies here. The next Architect migration is
`cf-terraform-demos/architect/migrations/0003_create_diagram_collaborators.sql`, after the existing
`0001_create_diagrams_and_users.sql` and `0002_create_diagram_shares.sql`. It is run locally through
`pnpm migrate:local`, which expands to:

```text
node ../../scripts/d1-migrate.ts --cwd . --outputs infra/local-outputs.json --local
```

and remotely through `pnpm migrate:remote`, which expands to:

```text
node ../../scripts/d1-migrate.ts --cwd . --outputs infra/outputs.json
```

The repository-root helper invokes `cf d1 migrations apply` with the D1 id from the appropriate
Terraform output. It is the only migration route to document or script. Terraform continues to own
the database resource but not table schema, and Phase 17 introduces no Terraform resource, Access
application, Access destination, Worker name, hostname, or Durable Object declaration change.
`cloudflare.config.ts` already declares the self-bound SQLite `DiagramSession` through `cf`'s
`exports.durableObject(...)` and `bindings.durableObject(...)`; there is no Wrangler migration tag
or `wrangler.jsonc` to add.

### 5.2 Four-tier collaborator mapping

The source document's one `CollaboratorRepository` performs input validation, ownership decisions,
and D1 access. Architect must preserve its four tiers instead. Phase 17 should put collaborator
entities, email/body validation and rules such as “the owner cannot add themselves” in
`src/worker/domain/`; put `CollaboratorRepository` (and the extended accessible-diagram query port)
in `src/worker/application/ports/`; implement the D1 query adapter in
`src/worker/infrastructure/`; and put owner/collaborator authorization orchestration in a dedicated
application service injected from `src/worker/index.ts`. Routes remain thin HTTP/auth/body/response
adapters and must not construct repositories.

`DiagramRepository` currently deliberately exposes owner-blind `find`, while `DiagramService`
implements `requireOwned`. The source's proposed `findAccessible` should therefore become a
well-named application/service use case (with an adapter query capable of returning a diagram plus
`'owner' | 'editor'`) rather than a storage adapter taking authority decisions. The routes that need
an owner-only action continue to use the owner rule; graph read, graph fallback-save, and the live
pre-upgrade authorization switch to accessible-editor authorization. MCP tools need the same
explicit decision: source text says `findAccessible` once collaborators exist, so Phase 18 must not
leave agent tools on an owner-only path by accident.

### 5.3 `DiagramSession` and its port become a bidirectional coordination seam

Today `DiagramSession` is intentionally one-way. It accepts an authenticated WebSocket, pins the
identity in a serialized attachment, sends `connected` and `graph_updated`, rejects every client
message, and exposes the single RPC method `notifyGraphUpdated(graphData, updatedAt)`. Its
`DiagramSessionPort` correspondingly has `connect(...)` plus `notifyGraphUpdated(...)`; the
application service writes D1 directly, then notifies the object.

Phase 18 reverses that responsibility without creating another object. The shared
`src/live-sync-protocol.ts` must grow typed client frames and the richer server frame union. The
session hydrates disposable graph/owner metadata from D1 once after construction, maintains the
in-memory graph, sequence and recoverable write-chain tail, accepts an operation from
`webSocketMessage`, and emits a snapshot on connection plus applied/rejected operations. It still
uses `ctx.acceptWebSocket()`, socket attachments, the named identity-header scrubber, and no
`ctx.storage` graph copy.

The `DiagramSessionPort` should therefore lose `notifyGraphUpdated` and gain typed operations such
as `applyOperation(...)`, `applyWholeGraphReplace(...)`, and the snapshot/connection surface that
actually maps to the final RPC methods. Its infrastructure adapter alone calls
`getByName(diagramId)` and typed Durable Object RPC. `DiagramService.saveGraph` (REST resilience
fallback), MCP granular mutations, and MCP auto-layout all call that port; none may retain a direct
`replaceGraph` writer that races the session. The session receives the diagram id from its adapter
addressing and must receive or hydrate the owner id required for the existing owner-scoped
`replaceGraph` adapter call. The existing D1 repository currently names this write
`replaceGraph`, rather than the source document's `saveGraphData`; Phase 18 should use that actual
port or rename it consistently only as a deliberate refactor, never invent a second D1 API.

### 5.4 Correctness, errors, presence, and verification

Phase 18 must preserve the synchronous mutation rule: parse/validate an operation, apply the pure
function, canonicalize the replacement, assign the in-memory graph and increment sequence with no
`await` between graph read and replacement. **This port deliberately differs from the source
sequence at the next step:** repository policy requires a graph operation to persist through its
ordered chain before it is broadcast, because broadcasting first lets a connected client render a
change that a reload would not show if D1 rejects the write. Await the operation's ordered persist,
then broadcast the accepted operation and return. Its error boundary must catch stale-target
`notFound()` as `operation_rejected`, map other expected malformed/duplicate/domain failures safely
rather than crashing the object, and keep the chain tail live after any failed repository write. The
report's write-chain correction belongs in its tests: assert final order with the unchained clobber
counter-example, then separately assert the fresh-read reduction of stale intermediate writes for a
queued later link.

Phase 19 adds only ephemeral presence/cursor/selection maps or data derived from live sockets.
Those must be reconstructible from `ctx.getWebSockets()` plus attachments after hibernation, or be
allowed to reset and rebuild as connections speak again. They never enter D1 or Durable Object
storage. Phase 20's integration tests should use fresh diagram ids, open all listeners before the
operation being observed, consume every HTTP response body, and retain the current finite timeout,
serialized-file, and eviction cleanup configuration. It replaces the source document's “Wrangler
generation/type checks” with `pnpm fix`, `pnpm check`, `pnpm test`, and `pnpm test:coverage`; the
existing check already performs `cf workers types`, build contracts, `terraform fmt -check`, and
`terraform validate` without a cloud-reaching Terraform plan.

## 6. Status

Phase 16 is complete. The current platform documentation confirms the hibernation, crash-risk, and
input-gate foundations. Real `workerd` probes confirmed the same-object race, multi-client test
support, eviction behaviour, and the deliberately broken unchained clobber. They also found the
narrow but consequential correction recorded above: strict chain ordering is the final-persistence
safety property; fresh graph reads at a link's start are an intermediate-freshness optimisation, not
a promise that a slow already-started write can never temporarily persist an earlier graph. All
throwaway probe classes, test files, and temporary Miniflare bindings were removed after execution.
