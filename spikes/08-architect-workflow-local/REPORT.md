# Spike 08 Report: Local Workflow Orchestration

Run on 2026-08-07. This spike is confined to local Wrangler/workerd state. It contains no `ai`
configuration, no remote binding, no Terraform, no deployment, no Cloudflare API call, and never
uses `wrangler dev --remote`.

## Versions

| Component | Exact version |
| --- | --- |
| Node.js | `v26.7.0` |
| npm | `11.19.0` |
| Wrangler | `4.120.0` |
| workerd | `1.20260801.1` |
| Miniflare | `5.20260801.1-alpha` |
| `@cloudflare/vitest-pool-workers` | `0.20.3` |
| Vitest | `4.1.10` |
| TypeScript | `7.0.2` |

`npm ls wrangler @cloudflare/vitest-pool-workers vitest typescript workerd miniflare --depth=1`
produced the versions above. `npx wrangler --version` returned `4.120.0`.

## Source-verified

- The current Workflow API supports `WorkflowEntrypoint`, `step.do`, step retry configuration,
  `WorkflowInstance.status()`, and `WorkflowInstance.pause()`, `resume()`, `restart()`, and
  `terminate()`. Source: generated `worker-configuration.d.ts` from Wrangler `4.120.0` and
  [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).
- Current local Workflow management requires a running local Wrangler session. Wrangler `4.79.0+`
  supports `wrangler workflows ... --local`; Local Explorer requires Wrangler `4.82.1+`.
  Source: [local development documentation](https://developers.cloudflare.com/workflows/build/local-development/).
- The current Durable Object configuration is declarative `exports`, not the legacy `migrations`
  array. `wrangler.jsonc` declares `DiagramRoom` with `type: "durable-object"` and
  `storage: "sqlite"`. Source: [Durable Object exports documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
- `step.do` provides a 1-indexed `context.attempt`. The generator step logs only `jobId` and
  attempt number, never a prompt or generated document. Source: [step context documentation](https://developers.cloudflare.com/workflows/build/step-context/).

## Locally verified

### Binding layout

`npm run dev` ran `wrangler dev --local` until the controlled five-second command timeout. Before
timeout, Wrangler reported all bindings as `local`:

| Binding | Resource | Mode |
| --- | --- | --- |
| `DIAGRAM_ROOM` | Durable Object | local |
| `ARCHITECTURE_WORKFLOW` | Workflow | local |
| `ARCHITECT_DB` | D1 Database | local |
| `PROPOSALS` | R2 Bucket | local |

Wrangler started at `http://localhost:8787` and exposed the local explorer Workflow API at
`/cdn-cgi/local/explorer/api/workflows`.

`npm run db:migrate:local` ran `CI=1 wrangler d1 migrations apply ARCHITECT_DB --local`; it applied
`0001_architecture_jobs.sql` successfully to `.wrangler/state/v3/d1`. This is deliberately local
only and the state directory is ignored.

### Test command and result

`npm run check:types` passed. `npm test` passed: **1 file, 7 tests**. The test pool uses the real
local bindings from `wrangler.jsonc`, not mocks:

1. Valid generation reaches `ready`, writes `proposals/success-job.json` to R2, records D1 metadata,
   keeps ordered room notification history, and preserves that history after
   `evictAllDurableObjects()`.
2. Malformed JSON reaches durable `failed`.
3. Unknown catalog product reaches durable `failed`.
4. Edge pointing at an absent node reaches durable `failed`.
5. One transient generator failure retries and reaches `ready`.
6. Exhausted generator retries run failure finalization and reach durable `failed`.
7. A duplicate HTTP start returns `duplicate: true` without a second Workflow or notification
   sequence.

The configured generator retry `limit` of `1` produced one retry after the initial attempt: the
transient fixture only succeeds when its generated `context.attempt` is `2`.

Miniflare logs intentional failed step attempts as `uncaught exception` before the Workflow's
top-level catch executes. These are expected fixture failures, not test failures: Vitest exited
successfully and D1/DO assertions prove finalization completed.

## Workflow design decisions

### Step boundaries

1. `summarize`: set D1 status to `summarizing`, then append a room notification; returns a compact
   semantic summary.
2. `mark generating`: set and notify `generating` once, before retryable work begins.
3. `generate`: call the generator seam; log each durable attempt.
4. `validate`: set and notify `validating`, parse raw output, and validate catalog products, unique
   node IDs, and non-self edges with existing endpoints.
5. `store`: set and notify `storing`, write R2 `proposals/<jobId>.json`, then write its key to D1.
6. `mark ready`: set and notify `ready` with the deterministic R2 key.
7. `finalize failure`: catch any terminal step failure, set D1 `failed`, then notify the room.

`transition()` writes D1 before calling `DiagramRoom.notify()`. The room inserts each notification
into SQLite and assigns a monotonic sequence before returning. This establishes order and makes
history available after Durable Object eviction. The real collaborative room can broadcast that
persisted transition after insertion.

### Retry and failure semantics

- Only `generate` has explicit retry configuration: `{ limit: 1, delay: 10, backoff: "constant",
  timeout: "1 second" }`. It makes two total generation attempts in this verified local runtime.
- The `transient` fixture throws only at attempt 1; attempt 2 returns the valid proposal.
- The `exhausted` fixture throws on every attempt. After the configured retry is exhausted, the
  top-level catch invokes `finalize failure`; the Workflow instance completes with output
  `{ status: "failed" }`, while D1 and the room both say `failed`.
- Malformed output, an unknown product, or an invalid edge becomes `NonRetryableError` in the
  validation step. The top-level catch still runs finalization, avoiding a D1 job left running.
- Workflow runtime status is `complete` for a business failure because finalization is handled.
  Application readers must use the D1 job status, not infer business success from runtime status.

### Generator seam

`ArchitectureGenerator.generate({ fixture, attempt, summary })` returns raw text. A future
Workers AI adapter implements this exact interface; parsing and schema/catalog validation stay on
the Workflow side. This spike compiles `DeterministicArchitectureGenerator`, selected through a
typed fixture in immutable Workflow input. It is deterministic, requires no network or binding,
and covers valid, malformed, transient, exhausted, unknown-product, and invalid-edge outcomes.

### IDs, keys, and idempotency

- The caller-owned `jobId` is the Workflow instance ID.
- The R2 key is exactly `proposals/<jobId>.json`.
- `INSERT OR IGNORE` creates the D1 job once. A duplicate `POST /jobs` returns `200` with
  `duplicate: true` and does not call `Workflow.create()`.
- R2 retries reuse the key. The current `put()` is idempotent for the same validated serialized
  proposal; Phase 5 should decide whether create-only object semantics are required once a job can
  be restarted.

## Instance inspection and harness limits

The supported Vitest pool **can start and inspect** a local Workflow through the generated binding:
the test calls `env.ARCHITECTURE_WORKFLOW.get(jobId)`, polls `instance.status()`, and observes the
returned workflow output. It also directly inspects real local D1/R2 and uses
`runInDurableObject()` to inspect plain room history. The pool auto-runs instances; this spike did
not find a supported Vitest mechanism to deterministically single-step or manually advance a
Workflow between named steps. It therefore verifies boundaries through durable side effects and
terminal workflow status rather than pausing at each boundary.

Supported local alternatives, demonstrated by the successful local Wrangler startup, are:

```sh
npm run dev
npx wrangler workflows list --local
npx wrangler workflows instances describe spike-08-architecture-workflow <jobId> --local
# Browser/local API: http://127.0.0.1:8787/cdn-cgi/explorer
```

The current Local Explorer also exposes `/cdn-cgi/local/explorer/api/workflows`; its interactive
controls can inspect, pause, resume, restart, terminate, or delete instances while `wrangler dev`
is running. That is suitable for manual step-history inspection, not deterministic Vitest test
control. No account polling is used.

## Cleanup

- Each test clears its isolated D1 table and evicts Durable Objects in `afterEach`; D1 is created
  in test setup because the Vitest pool's isolated in-memory D1 does not consume Wrangler's on-disk
  migration state.
- Test IDs are fixed and unique per test. Local Workflow instance state is pool-scoped and discarded
  when Vitest exits.
- `wrangler dev --local` stores disposable local state under ignored `.wrangler/`. Remove it with
  `rm -rf .wrangler` after manual exploration. The local explorer can delete retained local Workflow
  instances before that if desired.
- No named or billable remote resource exists to tear down.

## Deployed

**None.** Deployment is explicitly outside Spike 08 and was not attempted.

## Known gaps

- This proves local Workflows emulation, not deployed parity. Spike 10 must verify the final
  binding layout against deployed D1, R2, Durable Object, and the selected model.
- There is no local Workers AI simulation, intentionally. The generator seam is the local
  substitute; model request/response behavior belongs to the separately authorized deployed Spike
  09.
- The Vitest pool does not provide verified deterministic step-by-step advancement in this spike.
  Keep business-state assertions in D1/DO/R2 and use local Wrangler Explorer for manual workflow
  history inspection.
