# Report — `docs/09C-COLLABORATIVE-EDITING.md` Phase 16 spike

Run 2026-08-11. See `README.md` for the three items this answers.

## 1. Platform behaviors re-verified against current Cloudflare documentation

**Finding: both load-bearing behaviors `docs/09C-COLLABORATIVE-EDITING.md`'s
["Why D1 Stays The Only Copy"](../../docs/09C-COLLABORATIVE-EDITING.md#why-d1-stays-the-only-copy)
depends on are confirmed exactly as that document describes them. No correction needed.**

### 1a. In-memory (class field) state is discarded on hibernation/eviction

Confirmed directly, verbatim, across three current pages (not inferred from older material or
pre-trained knowledge):

- [Durable Object Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
  states plainly, as a boxed warning on the hibernation transition: **"When hibernated, the
  in-memory state is discarded, so ensure you persist all important information in the Durable
  Object's storage."** The same page's state table describes **Hibernated** as "The Durable
  Object is removed from memory" and **Inactive** (the state after the longer, 70–140 second
  eviction window that follows a non-hibernateable idle period) as "completely removed from the
  host process."
- [Durable Objects: WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
  (one of the three URLs `docs/09C-COLLABORATIVE-EDITING.md`'s own References section already
  cites) confirms the same fact from the hibernation-mechanism side: **"When a Durable Object
  receives no events... for a short period, it is evicted from memory. During hibernation: ...
  In-memory state is reset... When an event arrives, the Durable Object is re-initialized and its
  `constructor` runs."**
- [In-memory state in a Durable Object](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
  (the third of that References section's three URLs) states it a third, independent way:
  **"Because in-memory state is not preserved across eviction or hibernation, persist anything
  important to storage."**
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
  (current as of Jul 15, 2026 per its own "Last updated" stamp) states the same fact a fourth time,
  in its "Understand the difference between in-memory state and persistent storage" section, and
  adds one detail `docs/09C-COLLABORATIVE-EDITING.md` does not currently mention: **"In-memory
  state is not preserved if the Durable Object is evicted from memory due to inactivity, *or if it
  crashes from an uncaught exception*."** This is directly relevant to Phase 18's planned
  implementation — an uncaught exception thrown out of `applyOperation()` (for example, a bug in a
  `graph-mutations.ts` function that is not one of the already-anticipated `notFound()` cases) can
  discard `this.graph` exactly like an ordinary hibernation/eviction would, not just a graceful
  idle timeout. This does not change Phase 16/17/18's design — D1 is already the only durable copy
  regardless of *why* `this.graph` gets discarded — but it is worth Phase 18 keeping in mind when
  deciding how broadly to catch errors inside `applyOperation()`'s mutation step, beyond the single
  `notFound()` case the document already names.

**No correction.** `docs/09C-COLLABORATIVE-EDITING.md`'s own framing ("that in-memory state is
**not** durable and is discarded whenever hibernation evicts the instance") matches the current
documentation exactly.

### 1b. Synchronous JavaScript execution (no `await`) cannot be interleaved by an incoming event

Confirmed directly against the current [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
guide's "Understand how input and output gates work" section, the canonical current explanation of
this mechanism:

> While Durable Objects are single-threaded, JavaScript's `async`/`await` can allow multiple
> requests to interleave execution while a request waits for the result of an asynchronous
> operation. Cloudflare's runtime uses **input gates** and **output gates** to prevent data races
> and ensure correctness by default.
>
> **Input gates** block new events (incoming requests, fetch responses) while synchronous
> JavaScript execution is in progress. Awaiting async operations like `fetch()` or KV storage
> methods opens the input gate, allowing other requests to interleave.

The same page's "Anti-patterns to avoid" section states the underlying fact even more directly,
independent of the input-gate mechanism specifically: **"While async operations allow request
interleaving, all synchronous JavaScript execution is single-threaded."** [What are Durable
Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
corroborates from the "Actor programming model" framing: "executing some logic in its own
single-threaded context... avoids most of the concurrency pitfalls you get when doing concurrency
through shared memory," and cites Cloudflare's own
[_Durable Objects: Easy, Fast, Correct — Choose three_](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
blog post as the fuller mechanism explanation.

**No correction.** `docs/09C-COLLABORATIVE-EDITING.md`'s own framing ("with no `await` between
reading `this.graph` and replacing it, no other incoming message can possibly interleave in the
middle, by ordinary single-threaded JavaScript semantics") matches current documentation exactly —
including the important nuance that this guarantee is specifically about the *synchronous* portion
of a handler; the moment `applyOperation()`'s own write-chain `await` is reached, the input gate
opens and a second, concurrently-arriving operation's synchronous mutation step *can* run before
the first operation's `await` resolves. This is not a gap in the design — it is exactly the
behavior items 2 and 3 below confirm the design already accounts for (a later mutation is expected
and required to be able to interleave *after* an earlier operation's synchronous step has already
completed and moved on to awaiting its write-chain turn; what must never happen is two mutations'
own synchronous steps interleaving with *each other*).

## 2. The race, prototyped directly: exactly one deterministic winner, neither operation dropped

**Finding: confirmed by execution, not merely by re-reading platform documentation.**
`tests/concurrent-race.test.ts`'s first test dispatches two RPC calls to one
`TestDiagramSession` instance — `applyOperation("shared-node", "value-from-editor-a")` and
`applyOperation("shared-node", "value-from-editor-b")` — without an `await` between them, so both
are in flight simultaneously from the test's own perspective. Real, observed behavior across five
consecutive `vitest run` invocations (no flakes):

- Both calls' synchronous mutation steps ran, and ran in some strict, non-interleaved order:
  `this.sequence`, incremented synchronously inside the mutation step before any `await`, always
  produced two *distinct* values (`{1, 2}` in every observed run, never a duplicate or a gap) —
  the mutation-order tie-breaker `docs/09C-COLLABORATIVE-EDITING.md` itself would use as its own
  `this.sequence` field (see [Message Protocol](../../docs/09C-COLLABORATIVE-EDITING.md#message-protocol)).
  A duplicate sequence number would have meant the two increments interleaved and lost an update —
  never observed.
- `appliedLog` always contained exactly two entries, one per operation — neither operation
  vanished. Both editors' values were genuinely applied to `this.graph` at some point, exactly as
  `docs/09C-COLLABORATIVE-EDITING.md`'s
  [Concurrency Model](../../docs/09C-COLLABORATIVE-EDITING.md#concurrency-model) describes ("the
  record of *what value won* is always visible and correct, only the *earlier* value is gone").
- The final in-memory `this.graph["shared-node"]` and the final persisted `this.persisted["shared-node"]`
  always matched *the operation with the higher sequence number* — i.e. whichever operation's
  synchronous mutation genuinely ran last — regardless of which operation's own `Promise`
  happened to resolve first. This is the exact "last-applied-wins" guarantee
  `docs/09C-COLLABORATIVE-EDITING.md`'s Concurrency Model section names, confirmed to actually hold
  at the Durable Object level, not merely asserted in prose.

A second test in the same file confirms the negative case named in that same Concurrency Model
section ("two operations targeting different nodes/edges: no interaction at all"): two concurrent
operations on two different node ids left both values intact in both the in-memory graph and the
persisted stub, with no cross-contamination.

## 3. A slow write cannot land after, and clobber, a faster, later-enqueued write

**Finding: confirmed by execution, including a deliberate counter-example proving the assertion is
not vacuous.** `tests/slow-write-ordering.test.ts` runs the identical adversarial scenario — editor
A dispatched first with an artificially slow (50ms) simulated persist, editor B dispatched second
with none — through two different write paths on the same `TestDiagramSession` class:

- **The naive, unchained path (`applyOperationUnchained`) — confirmed broken, as expected.** Each
  call captures its own snapshot of `this.graph` immediately (at call time, before its own delay),
  then persists that snapshot independently, with no shared ordering against any other call's
  persist. Observed, consistently: the in-memory graph ends up correct
  (`graph["shared-node"] === "value-from-editor-b"`, since editor B's mutation genuinely ran after
  editor A's), but the "D1" stub (`persistedUnchained`) ends up holding **editor A's stale value**
  — editor A's slow persist finishes *after* editor B's fast one already landed the correct value,
  and clobbers it. This is the exact failure mode
  `docs/09C-COLLABORATIVE-EDITING.md`'s "Why D1 Stays The Only Copy" section's write-chain design
  exists to prevent, reproduced on demand rather than taken on faith. It also confirms this
  spike's tests have real discriminating power: a test suite that could not fail against a
  deliberately broken alternative implementation would not be meaningful evidence for the correct
  one.
- **The real write-chain path (`applyOperation`, `this.writeChain`) — confirmed correct.** Run
  through the identical delay scenario, the "D1" stub always ends up holding whichever operation's
  synchronous mutation genuinely ran last (editor B's, in this scenario) — never editor A's stale
  value, despite editor A's write-chain link being the one carrying the artificial delay. A third
  test in the same file polls `persisted` repeatedly (every 4ms) while editor A's 30ms-delayed link
  is still in flight and confirms there is no transient window at all where the stale value is
  observable as "persisted," even briefly — every sample was either `null` (no link had completed
  yet) or already editor B's correct value, and the sampling window was confirmed to have actually
  spanned the write landing (not merely completed too early to observe anything).

This directly confirms the mechanism `docs/09C-COLLABORATIVE-EDITING.md` attributes the guarantee
to: **strict per-object ordering (each write-chain link only starts once the previous one
resolves) combined with a fresh read of `this.graph` inside each link's own callback, evaluated at
the moment that link actually runs rather than when it was enqueued.** Either property alone would
not be sufficient — the counter-example's naive path has neither, which is why it fails — but
together they are what make an older, slower write structurally incapable of overwriting a newer
one, without requiring any platform-level storage-ordering guarantee from D1 itself.

## Definition of done

Per `docs/09C-COLLABORATIVE-EDITING.md`'s Phase 16: all three items above have a written answer
here, executed rather than assumed for items 2 and 3, with citations for item 1. Findings are also
recorded in `docs/DECISIONS.md` under "NEW DECISIONS" (entry 32), per that document's own
instruction that Phase 16 findings be recorded there before Phase 17 starts.

**No correction to `docs/09C-COLLABORATIVE-EDITING.md`'s design.** Both load-bearing platform
behaviors hold exactly as described, and the write-chain mechanism ("Why D1 Stays The Only Copy")
is confirmed, by direct execution against a Durable Object shaped like the real one, to produce
the exact "no lost updates, no corrupted graph, deterministic last-write-wins" outcome that
document's [Concurrency Model](../../docs/09C-COLLABORATIVE-EDITING.md#concurrency-model) section
promises. Phase 17 and Phase 18 can proceed against the design as written. The one detail worth
carrying forward into Phase 18's implementation (not a design change, an implementation note): per
§1a above, an uncaught exception inside `applyOperation()`'s synchronous mutation step discards
`this.graph` exactly like a hibernation/eviction would, so Phase 18 should make sure any
`graph-mutations.ts` failure mode it has not already anticipated (today, only `notFound()`) is
still caught and turned into `operation_rejected` rather than left to crash the instance —
harmless for data durability (D1 is unaffected either way), but avoids an avoidable in-memory-cache
cold start for every other client connected to that same diagram at the moment it happens.
