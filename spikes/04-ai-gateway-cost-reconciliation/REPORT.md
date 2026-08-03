# Spike F Report — AI Gateway cost/log reconciliation

Run against the real account on 2026-08-03, using this repo's root `.env`. Every resource this
spike created (the dedicated AI Gateway, its one dynamic route, the Access application/policy,
and the deployed Worker) was torn down immediately after this report was written; see "Cleanup
performed" at the end.

## 1. The working correlation mechanism: a per-turn UUID in `gateway.metadata`, matched via the logs-list API's `filters` query param

Spike B confirmed `env.AI.aiGatewayLogId` is `null` for every dynamic-route call, and found AI
Gateway's own logs-list API (`GET /accounts/{account}/ai-gateway/gateways/{id}/logs`) still
records a full, correctly-costed entry for the resolved model — including the request's own
metadata — but did not find a working way to query for a *specific* call's row. This spike closes
that gap.

**The Cloudflare API reference for this endpoint documents a `filters` query parameter** (an array
of `{ key, operator, value }` objects; confirmed by fetching
`developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/` directly,
since neither Spike B nor the narrative logging docs page names it) that the public logging docs
page does not surface at all — it only documents the *dashboard's* filter UI, not this REST
parameter. Two non-obvious shape gotchas, found by testing directly against the account's
pre-existing `demo-gateway` before ever calling this spike's own gateway:

- **Bracket-notation query params are silently ignored.** `filters[0][key]=model&filters[0][operator]=eq&filters[0][value]=...`
  (the encoding several other Cloudflare list endpoints accept) returns the **unfiltered** result
  set with no error — confirmed by comparing `result_info.total_count` with and without it (236
  both times). The endpoint expects **one query parameter named `filters` whose value is a single
  JSON-encoded string**: `filters=[{"key":"model","operator":"eq","value":["..."]}]`.
- **`value` must be a JSON array, even for a single value** — passing a bare string
  (`"value":"..."`) fails validation: `{"errors":[{"code":7001,"message":"Expected array, received
  string","path":["query","filters",0,"value"]}]}`. Wrapping it (`"value":["..."]`) succeeds. (The
  API reference does say `value: array of string|number|boolean`, but it is easy to miss that this
  applies even to a single-value equality check.)
- `per_page` has an undocumented (in the narrative docs) hard maximum of `50` —
  `{"errors":[{"code":7001,"message":"Number must be less than or equal to 50", ...}]}` for
  anything higher.

**Confirmed working correlation, live, end to end**: this spike's Worker attaches a fresh
`crypto.randomUUID()` as `gateway.metadata.requestId` on every `env.AI.run()` call
(`src/index.ts`). `scripts/probe.mjs` then queries the same gateway's logs-list endpoint with
`filters=[{"key":"metadata.value","operator":"eq","value":["<the same uuid>"]}]`, sorted
`created_at` desc, and reliably finds exactly the one row that call produced — across 11
sequential trials and 10 concurrent calls in this run (Section 3), **zero misses, zero wrong
matches**. Once found, the row's own `id` was cross-checked through the binding's documented
`getLog(id)` (via this spike's `/log` endpoint) and matched exactly (Section 4).

### The real limitation: `metadata.key`/`metadata.value` filters are not paired to the same entry

The logs-list API reference also lists `metadata.key` and `metadata.value` as separate filterable
`key` enum values, which reads as if combining both filters lets a caller ask "does this log have
a metadata entry where key=X **and** value=Y". **Live-tested against the account's own
pre-existing `demo-gateway` metadata (many rows with `{"team": "sales-ops", "actor_id":
"agent-lead-enrichment", ...}`) and confirmed this is false**: filtering
`metadata.key = "team"` (a key present on essentially every row) **and**
`metadata.value = "agent-lead-enrichment"` (a value that only ever appears under the *different*
key `actor_id`, never under `team`) still returned all 117 matching rows — the exact same count as
filtering `metadata.value = "agent-lead-enrichment"` alone. The two sub-filters are independently
applied existence checks across the whole metadata map, **not** a paired key=value match.

**Consequence for Phase 6, stated plainly**: the correlation value alone (not the key it happens
to be stored under) is what must be unique enough not to collide with anything else the gateway
has ever logged. A random per-turn UUID is safe (astronomically unlikely to collide with any other
value, metadata or otherwise, across the gateway's full history) — but a value that is *not*
naturally unique on its own (a chat ID reused across many turns, a `business` segment name, a
short numeric counter) is **not** safe to correlate on through this filter alone, even paired with
a `metadata.key` filter naming the intended field, since that pairing is not actually enforced.
Phase 6 must mint a dedicated, single-use correlation value (this spike used a UUID) per turn, not
reuse an existing identifier that is not already unique across the gateway's whole log history.

**Cross-field filters (different `key` values in the `filters` array) genuinely ARE ANDed
together**, unlike the two metadata sub-filters — confirmed by combining a `model` filter (23
matching rows alone) with a `metadata.value` filter (87 matching rows alone) and getting exactly
19 back (the true intersection, not either individual count). `metadata.key`/`metadata.value`'s
lack of pairing is specific to those two keys interacting with each other, not a general filters
bug.

**`eq` is an exact match, not a substring/prefix match** — filtering `metadata.value = "agent"`
returned only rows whose metadata literally contained the value `"agent"` (182 of them), never a
row whose only matching value was the longer string `"agent-lead-enrichment"` — confirmed by
checking every returned row's metadata values directly.

## 2. Chosen mechanism for Phase 6: mint a correlation UUID at `onFinish`, not reuse `aiGatewayLogId`

Section 6.6's reconciliation design as originally written schedules `reconcileUsage` with
`gatewayLogId: env.AI.aiGatewayLogId` — that field is `null` for every real turn (Spike B), so
this cannot work. The corrected design, informed by this spike:

1. **Immediately before calling `env.AI.run()`**, generate `const correlationId =
   crypto.randomUUID()` and pass it as `gateway.metadata.correlationId` (alongside `business` and
   whatever else Phase 7/8 need — AI Gateway accepts at most **five** metadata entries per
   request, a real, tightening constraint on how many identifying fields a turn's metadata can
   carry simultaneously; Phase 6/7/8 must coordinate on which fields actually need to ride in
   metadata rather than each independently assuming headroom).
2. **`onFinish`'s immediate `chat_usage` row insert** (`cost_source = 'estimated'`) stores this
   `correlationId`, not a `gatewayLogId` — there is no real gateway log id available yet at this
   point. (`chat_usage.gateway_log_id`, Section 6.4, remains the right column name for what it
   eventually holds — the *real* AI Gateway log id, once reconciliation actually finds it — but a
   dedicated `correlation_id` column, distinct from `gateway_log_id`, is now needed to carry the
   value reconciliation searches for. `docs/06-AGENTIC-CHAT.md`'s Section 6.4 is updated
   accordingly.)
3. **`this.schedule(delaySeconds, "reconcileUsage", { chatUsageId, correlationId })`** — same
   Agents SDK scheduling primitive Section 6.6 already specifies, just carrying the corrected
   payload field.
4. **`reconcileUsage(payload)`** calls the logs-list REST API (not the binding — the `AiGateway`
   binding class has no list-logs method at all, confirmed by reading the generated
   `worker-configuration.d.ts`: only `getLog(id)`, `patchLog(id, data)`, and `getUrl(provider)`
   exist) with `filters=[{"key":"metadata.value","operator":"eq","value":[correlationId]}]`. A
   non-empty result means the row's own `tokens_in`/`tokens_out`/`cost` (Spike B's confirmed field
   names) can update the `chat_usage` row directly and flip `cost_source = 'gateway'`, storing the
   row's real `id` into `gateway_log_id` for later reference (worth doing even though the list
   response already carries the numbers this demo needs — the fuller `getLog(id)` shape, including
   `request_head`/`response_head`, Section 3 below, could still matter for Phase 12's exports if a
   more complete transcript record is ever wanted there). An empty result is the "not yet
   available" signal for a dynamic-route call (**there is no dedicated `getLog()`-style thrown
   error for this path** — the list simply returns zero rows) — increment `reconcile_attempts` and
   reschedule with backoff, exactly as Section 6.6 already specifies.
5. **This REST call needs the account's own API token available to the Worker** (`getLog()`/
   `patchLog()` are binding methods needing no separate credential, but there is no equivalent
   binding method for listing logs) — Phase 6 must add a Wrangler secret for this, a real,
   previously-unstated infrastructure requirement this spike surfaces. This is the one place this
   demo's own guidance to "prefer bindings over calls to Cloudflare's REST API from inside a
   Worker" (AGENTS.md) cannot be followed, because no such binding exists for this specific
   operation — document this exception explicitly in `EXPLAIN-DEMO.md` rather than silently
   deviating from that rule.

## 3. Concurrency: confirmed safe, no serialization needed

`GET /call-concurrent?n=5` fires five `env.AI.run()` calls via `Promise.all` inside one Worker
invocation, each with its own `crypto.randomUUID()` metadata tag. Run twice (Section 6, raw data):
**10 of 10 calls correlated correctly to 10 distinct log rows, zero collisions, zero
cross-talk** — one run's five results:

```
slot 0 requestId=58316089-... -> found log 4fa8d5ce... after 304ms
slot 1 requestId=76231fbe-... -> found log 64924fca... after 2582ms
slot 2 requestId=90e63d92-... -> found log eeb428ab... after 277ms
slot 3 requestId=cb559ffd-... -> found log ec118d69... after 299ms
slot 4 requestId=3b873cae-... -> found log fa57c79f... after 299ms
```

Each resolved log row's own `metadata.requestId` was independently confirmed to match the slot
that produced it (Section 6's raw JSON). **No serialization of concurrent `env.AI` calls within
`ChatAgent` is required** to keep correlation reliable — this answers the open question in Spike
F's aim directly. This makes sense given the correlation mechanism itself (a globally unique value
per call, checked by exact-match query) has no shared mutable state for concurrent calls to race
on, unlike the rejected `aiGatewayLogId`-on-the-binding-instance approach might have.

## 4. `getLog()` re-confirmed, plus a richer shape than the list response

Once a row was found via the list, calling this spike's `/log?id=<that row's id>` endpoint (the
binding's `getLog()`) returned successfully every time and matched the list entry's
`tokens_in`/`tokens_out`/`cost`/`metadata` exactly — confirming Spike B's finding continues to
hold for a row discovered by this new correlation path, not just for a literal-model-ID call.
`getLog()` additionally returns `request_head`/`response_head` (the actual request/response
bodies, truncated) that the list response does not include — potentially useful for Phase 12's
export feature, though not required for Phase 6's own cost/token reconciliation. Re-confirmed
Spike B's "not found" signal is a **thrown** `AiGatewayLogNotFound: Log not found` error, not a
`404`-shaped return value (`errorName: 'AiGatewayLogNotFound', errorMessage: 'Log not found'`,
live-verified again with a made-up id in every run of this spike).

## 5. `gateway.eventId` re-tested, still does not correlate

Spike B tried a custom `cf-aig-event-id` header/`gateway.eventId` binding option and found it
never appeared on the resulting log row. This spike re-tested it with the corrected `filters`
query shape (Section 1) in case Spike B's negative result was a query-syntax problem rather than a
real platform gap: `env.AI.run()` was called with both `gateway.metadata.requestId` **and**
`gateway.eventId` set to the identical UUID. The resulting log row's own `event_id` field was
still `""` (confirmed directly, not just inferred from a failed filter), and filtering
`filters=[{"key":"event_id","operator":"eq","value":["<the same uuid>"]}]` correctly returned zero
rows (a true negative — the query syntax itself works, as proven by every other filter test in
this report; the field is simply never populated by this call path). **Conclusion: `gateway.eventId` /
`cf-aig-event-id` is not a usable correlation mechanism for a Workers `AI` binding call in this
account's observed behavior, dynamic-route or otherwise** — the `metadata`-based approach
(Section 1) is not a second-best fallback, it is the only mechanism that worked in either spike.

## 6. Measured reconciliation lag: low seconds, not minutes

11 sequential single-call trials across two runs (a fresh `crypto.randomUUID()` correlation value
per trial, polled every 2 seconds starting immediately after the call's own HTTP response
returned) all found their row on the first or second poll:

| Run | Trials | Found | Min lag | Max lag | Avg lag |
| --- | --- | --- | --- | --- | --- |
| 1 | 5 | 5/5 | 322 ms | 3,151 ms | 2,224 ms |
| 2 | 6 | 6/6 | 267 ms | 4,731 ms | 2,174 ms |
| **Combined** | **11** | **11/11** | **267 ms** | **4,731 ms** | **~2,200 ms** |

This measurement's methodology is honestly a **ceiling**, not a pure ingestion-lag figure — it
includes the full wall-clock round trip of the probe's own separate REST call to the logs-list
endpoint from a machine outside Cloudflare's network, not just server-side ingestion time. Even
so, **every trial's row was queryable well under five seconds after the call itself completed**,
directly contradicting Section 6.6's original hedge (based on AI Gateway's own docs describing
*spend limits* specifically as "eventually consistent") that logged cost data might share a
similar multi-second-to-minutes lag. It does not, at least not at this spike's traffic volume on a
freshly created, otherwise-idle dedicated gateway — a caveat worth stating plainly: production
load on a shared gateway serving every real chat turn could behave differently, which is exactly
why Phase 6's bounded-retry design (not a single fixed-delay assumption) is still the right shape,
just with much shorter delays than an "eventually consistent" framing would suggest.

**Recommended `this.schedule()` delay/backoff for Phase 6**, informed by this data with a
comfortable safety margin over the observed maximum: an initial delay of **10 seconds**, then two
retries with linear backoff (**+15 seconds**, **+15 seconds**) if the first attempt's list query
comes back empty — three attempts total, ~40 seconds worst case before a row is left permanently
`estimated` (Section 6.6's own "small, bounded attempt count (for example 3)" wording, now with
concrete numbers).

## 7. Bonus finding: a failed dynamic-route call still produces a correlatable log row

Two of the eleven sequential trials hit a transient `AiGatewayError 2002: Failed to parse model
output` from `@cf/google/gemma-4-26b-a4b-it` (the same model-through-a-dynamic-route flakiness
Spike B flagged as "observed once, not reproduced on immediate retry, treat as flaky, not
broken" — this run's 2-of-11 rate suggests it may be somewhat more frequent than Spike B's single
sample implied, though eleven calls is still too small a sample to treat as a reliable rate).
**Both failed calls still produced their own log row, still carrying the request's full
metadata**, exactly matching Spike B's separate finding about a route-level failure:
`model: "dynamic/spike-cost-recon-route"` (the route name itself, not a resolved model),
`provider: "unknown"`, `cost: 0`, `success: false`. `getLog()` on that row's id succeeded and
returned `response_head: '{"state":"Failed","error":"Model execution failed (...)"}'`. This means
Phase 6's reconciliation path does not need a special case for a failed turn — the same
correlation-and-fetch logic finds a real row either way, correctly showing zero cost — only a
turn that fails *before* AI Gateway logs anything at all (a network error before the request
reaches the gateway, for example) would need the "give up after N attempts, stay `estimated`"
path to actually trigger from a truly missing row rather than a `cost: 0` failed one.

## Corrections applied to `docs/06-AGENTIC-CHAT.md`

1. Spike F's own entry (Section 9, Phase 0) — marked complete with a summary of the findings
   above.
2. Section 6.6 — rewritten reconciliation design: `correlationId` (a UUID minted at `onFinish`,
   carried in `gateway.metadata`) replaces `env.AI.aiGatewayLogId` as the value threaded through
   `this.schedule()`; reconciliation queries the logs-list REST API (`filters=[{"key":
   "metadata.value","operator":"eq","value":[correlationId]}]`) since no binding method lists
   logs; the not-yet-available signal is an empty result array, not a thrown error; concrete
   `this.schedule()` delay/backoff numbers (10s, then +15s twice) from Section 6 above; a note
   that this is the one place this demo calls the Cloudflare REST API from inside a Worker instead
   of a binding, because no binding exists for this operation, requiring a Wrangler secret for the
   API token.
3. Section 6.4 — `chat_usage` gains a `correlation_id` column (the value reconciliation searches
   for) distinct from `gateway_log_id` (the real AI Gateway log id, populated only once
   reconciliation actually finds the row).

See the corresponding `docs/DECISIONS.md` "NEW DECISIONS" entry for the condensed, reusable
version of all of the above.

## Cleanup performed

- `cd infra && terraform destroy` — removed the dynamic route, the AI Gateway, and the Access
  application/policy.
- `wrangler delete` — removed the deployed `spike-04-ai-gateway-cost-reconciliation` Worker.
- No scratch resources were created against the account's pre-existing `demo-gateway` in this
  spike (unlike Spike B) — every filter-syntax experiment in Section 1 only ever *read* that
  gateway's existing logs, never wrote to it.
