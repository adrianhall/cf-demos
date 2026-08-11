# Spike — `docs/09C-COLLABORATIVE-EDITING.md` Phase 16 (concurrency correctness of `DiagramSession`'s planned write path)

**Aim** (`docs/09C-COLLABORATIVE-EDITING.md`'s
[Phase 16 — Spike](../../docs/09C-COLLABORATIVE-EDITING.md#phase-16---spike-tag-phase-16-collab-spike)):
answer, before writing any Phase 17/18 feature code, the three items that phase lists —
all in service of confirming the correctness argument in that document's
[Why D1 Stays The Only Copy](../../docs/09C-COLLABORATIVE-EDITING.md#why-d1-stays-the-only-copy)
section actually holds, not just reads plausibly:

1. Re-verify, against current Cloudflare documentation, that (a) a Durable Object's in-memory
   (class field) state is discarded on hibernation/eviction, and (b) synchronous JavaScript
   execution with no `await` between two statements cannot be interleaved by an incoming event
   inside one Durable Object instance.
2. Prototype the race directly: two clients sending conflicting operations — both targeting the
   same node id — to one Durable Object instance, asserting the final persisted state reflects
   exactly one deterministic winner and neither operation is silently dropped.
3. Confirm a slow simulated persist genuinely cannot land after, and clobber, a faster,
   later-enqueued one.

**Short version — all three confirmed, no correction needed to the design.** (1) is
confirmed directly against the live API reference, not merely assumed (see `REPORT.md` §1 for
citations). (2) and (3) are proven by two real (non-mocked) `@cloudflare/vitest-pool-workers`
integration tests in `tests/`, both passing against a small standalone Durable Object
(`src/diagram-session.ts`) built to mirror the *shape* of the real, not-yet-implemented
`DiagramSession.applyOperation()` write path (`this.graph`, `this.writeChain`) closely enough to
exercise the same two platform guarantees. `tests/slow-write-ordering.test.ts` also includes a
deliberate counter-example — the same delay scenario driven through a naive, unchained write path
instead — which *does* reproduce the exact clobber bug the real design's write chain exists to
prevent, confirming the test suite has real teeth rather than asserting a foregone conclusion.

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions", which this repository's other spikes
already follow). It is exempt from the demo contract (no custom domain, no
`DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure).

## Why this spike stays entirely local — no Terraform, no Access application

This spike needs no inbound HTTPS endpoint at all — `@cloudflare/vitest-pool-workers` boots a
real, local `workerd` instance and both test files call RPC methods directly on a
`TestDiagramSession` Durable Object stub inside it. Per the Spike Conventions section's first
bullet ("a spike that never exposes an inbound HTTPS endpoint... needs neither Terraform nor an
Access application"), this spike has no real-account footprint, and so there is nothing to tear
down. `src/index.ts`'s `fetch()` handler is a placeholder that exists only so Wrangler has a
`main` module to boot `workerd`; it is never deployed and never exercised by any test.

## Why RPC calls, not real WebSocket connections

`docs/09C-COLLABORATIVE-EDITING.md`'s Phase 16 item 2 itself allows either ("two simulated
WebSocket (or plain RPC-call) clients"). This spike uses direct RPC calls on the Durable Object
stub: the platform guarantee under test is `TestDiagramSession`'s own single-threaded execution
model (no interleaving of synchronous code, one write chain per instance) — a guarantee that
holds identically regardless of which transport delivered the request that triggered it. A real
hibernatable-WebSocket harness would add the `testing-durable-objects` skill's serialization and
cleanup machinery for no additional evidence about the specific question this spike answers, and
Phase 18 (the phase that actually builds the WebSocket protocol) is where that transport-level
testing belongs.

## Drive it

```bash
npm install
npm run test         # runs both integration test files against a real local workerd instance
npm run check:types  # tsc --noEmit
```

All 5 tests in `tests/` **pass**, confirming the design — see `REPORT.md` for the full findings
and citations.

## Files

- `src/diagram-session.ts` — `TestDiagramSession`, a small standalone Durable Object exposing two
  side-by-side write paths: `applyOperation()` (the real design — a shared write chain,
  `this.writeChain`, where each link re-reads `this.graph` at the moment it actually runs) and
  `applyOperationUnchained()` (the naive alternative the real design's own prose argues against —
  each call persists an independently-captured snapshot with no shared ordering). See that file's
  own JSDoc for the full correspondence to `docs/09C-COLLABORATIVE-EDITING.md`'s planned
  `DiagramSession.applyOperation()`.
- `src/index.ts` — placeholder `fetch()` handler; exists only so Wrangler has a `main` module to
  boot `workerd` for the tests above, and so `TestDiagramSession` has somewhere to be exported
  from for the `durable_objects` binding. Never deployed.
- `wrangler.jsonc` — minimal config: one Durable Object binding, `new_sqlite_classes` migration
  (required by Wrangler for any Durable Object class, even though `TestDiagramSession` never calls
  `ctx.storage`, exactly like the real `DiagramSession`).
- `tests/concurrent-race.test.ts` — Phase 16 item 2: two concurrent operations targeting the same
  node id; asserts exactly one deterministic winner, neither operation silently dropped; also
  confirms two operations on *different* nodes never interact.
- `tests/slow-write-ordering.test.ts` — Phase 16 item 3: a slow first write racing a fast second
  write, run twice — once through the naive unchained path (confirmed broken, the counter-example)
  and once through the real write-chain design (confirmed correct), plus a polling test confirming
  there is no transient window where the stale value is briefly observable as "persisted" either.

## What this spike does not do

No real D1, no real WebSocket connections, no MCP tool call, no browser client, no presence/cursor
protocol — none of Phase 17/18's actual feature surface. This spike answers exactly the three
concurrency-correctness questions Phase 16 asks, using the minimum code needed to exercise the
platform's own execution-model guarantees against a Durable Object shaped like the real one.
