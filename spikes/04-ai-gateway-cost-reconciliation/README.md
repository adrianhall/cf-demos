# Spike F — AI Gateway cost/log reconciliation

**Aim** (docs/06-AGENTIC-CHAT.md, Phase 0, Spike F): determine exactly how this demo reads back a
completed turn's authoritative cost and token counts, since Section 6.6 makes that the ledger's
preferred source rather than the local pricing-table fallback. Spike B
(`spikes/01-ai-gateway-dynamic-routing/REPORT.md`) already confirmed a dynamic route name can be
passed directly as `env.AI.run()`'s `model` argument, but that doing so leaves
`env.AI.aiGatewayLogId` **`null`** — reproduced across a dozen-plus real calls there. This spike's
central, still-open question is therefore not "does `aiGatewayLogId` work" (already answered: no)
but **"what reliably identifies which AI Gateway log row corresponds to a specific dynamic-route
call, given `aiGatewayLogId` is unusable for it"**, plus the follow-on questions Section 6.6's
two-write reconciliation design depends on: whether concurrent `env.AI` calls need serialization
to keep that identification reliable, the confirmed `getLog()` response/error shape, and the
real-world lag between a turn completing and its log becoming queryable.

See `REPORT.md` for everything this spike actually found (a working correlation mechanism, its
real limitation, confirmed concurrency safety, and measured lag numbers) — all already applied to
`docs/06-AGENTIC-CHAT.md` Section 6.6 and `docs/DECISIONS.md` per Section 8's required feedback
actions.

## What this spike deploys

- `infra/main.tf` — one dedicated AI Gateway (`spike-04-cost-recon`) and one simple dynamic route
  (`spike-cost-recon-route`, `start -> model -> end`, no conditional — this spike is entirely
  about reading a call back afterward, not about routing logic, which Spike B already covered).
  Reuses `@cf/google/gemma-4-26b-a4b-it`, one of only four catalog models Spike B confirmed
  actually work through a dynamic route's `model` node.
- A deployed Worker (`src/index.ts`) exposing:
  - `GET /call?requestId=<uuid>[&business=<value>][&message=...]` — one dynamic-route
    `env.AI.run()` call, tagged with `requestId` (and optionally `business`) as AI Gateway custom
    metadata, plus `gateway.eventId: requestId` (re-testing Spike B's separate, already-failed
    event-id correlation attempt alongside this spike's own metadata-based one).
  - `GET /call-concurrent?n=<1-10>` — fires `n` such calls concurrently (`Promise.all`, all
    within one Worker invocation) to test whether concurrent `env.AI` calls can still be told
    apart afterward without serialization.
  - `GET /log?id=<logId>` — the binding's documented `getLog()`, used once a log id is known by
    another means (this spike's own correlation, below), to confirm it still resolves and to
    re-verify Spike B's confirmed response/error shape.
- `scripts/probe.mjs` — **this is the actual spike** (docs/06-AGENTIC-CHAT.md, Section 8: "Where
  a spike's only reasonable way to exercise the real platform is a [...] test, that one test is
  the spike"). It calls the Worker, then polls
  `GET /accounts/{account}/ai-gateway/gateways/{gateway}/logs` directly against the real account
  REST API (this repo's own `.env` credentials, per Section 8's "reuse the root `.env`" rule) with
  a `metadata.value`-equality filter, measuring the real reconciliation lag and confirming
  correlation correctness for both sequential and concurrent calls.

This spike deploys a real, publicly reachable Worker rather than staying inside `wrangler dev`,
for the same reason Spikes A and B did: `env.AI` has no local remote-binding simulation on this
account (Spike A's finding), so a live `env.AI.run()` call — and therefore any log it produces —
can only be observed against a real deployment.

## Access application (Section 8, second spike category)

This spike's Worker is fronted by a bypass-all Cloudflare Access application/policy, created and
torn down entirely by `infra/main.tf` (mechanism 1 of Section 8's two sanctioned options — a
minimal, spike-scoped Terraform config, copied verbatim from
`spikes/01-ai-gateway-dynamic-routing/infra/main.tf`'s own pattern). No manual Access step is
needed.

## Reproduce

```sh
npm install
cd infra && terraform init && terraform apply
cd ..
npm run deploy
```

Then, from the deployed hostname (`terraform -chdir=infra output -raw hostname`):

```sh
npm run probe -- --host "$(terraform -chdir=infra output -raw hostname)" --trials 5 --n 5
```

(`npm run probe` wires `node --env-file=../../.env` in automatically, so
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` come straight from this repo's root `.env` — no
separate credential setup.) This runs several sequential single-call trials (measuring
reconciliation lag), one concurrent batch (measuring correlation safety under concurrency), and a
made-up-id lookup (re-confirming `getLog()`'s "not found" signal), then prints a JSON summary plus
the full raw trial data.

## Teardown

```sh
cd infra && terraform destroy
cd .. && wrangler delete
```

`terraform destroy` removes the AI Gateway, its one dynamic route, and the Access
application/policy. `wrangler delete` removes the deployed Worker. Neither leaves a named or
billable resource behind.
