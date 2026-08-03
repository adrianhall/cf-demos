# Spike C — Dynamic Workers as the egress-control mechanism for the `getUrl` tool

**Aim** (docs/06-AGENTIC-CHAT.md, Phase 0, Spike C): prove the minimal working `globalOutbound`
gateway pattern for a single tool's outbound fetch. Confirm: the demo Cloudflare account is (or
can be put) on a **Workers Paid plan** (Dynamic Workers' current plan requirement); the exact
`worker_loaders` binding declaration and whether a Durable Object (`ChatAgent`, stood in here by
`ToolRunner`) sharing the main Worker script's `env` can call `env.LOADER.get()`/`.load()` the
same as the top-level `fetch()` handler could; the exact `ctx.exports.EgressGateway()` wiring for
passing a `WorkerEntrypoint` gateway class as `globalOutbound`, including whether `ctx.exports` is
available from inside a Durable Object method or must be threaded in from the Worker's own
`fetch()` call site; a working allow-list gateway that blocks a non-allow-listed host and permits
an allow-listed one, with both outcomes logged; and whether `@cloudflare/vitest-pool-workers`
supports `worker_loaders` locally for integration tests. See `REPORT.md` for what running it
actually showed (several findings corrected or sharpened an assumption in
`docs/06-AGENTIC-CHAT.md`, which has been updated).

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions"). It is exempt from the demo contract
(no custom domain, no `DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure).

## Why this spike stays entirely local — no Terraform, no Access application

Unlike Spike A (`spikes/00-aichatagent-basics`), whose `env.AI` binding needed a real deployment
because `wrangler dev`'s remote-binding proxy for `env.AI` could not complete on this account, this
spike's `worker_loaders` binding is **not** a proxy to any external, account-level Cloudflare
service at all — it is a pure `workerd` runtime primitive (there is no `remote: true` option for
`worker_loaders` in Wrangler's config schema, unlike `ai`/D1/KV/R2). `wrangler dev`'s default local
mode runs the **real** `workerd` binary, so a Dynamic Worker loaded, executed, and network-gated
through `globalOutbound` locally behaves identically to one running on the deployed edge — this is
not a separate "local simulation" the way KV/D1's local storage or `env.AI`'s remote proxy are.

Per Section 8's first bullet, "a spike that never exposes an inbound HTTPS endpoint... needs
neither Terraform nor an Access application" — this spike is exactly that case, confirmed live
(`README.md`'s "Drive it" section below never leaves `localhost`). The Workers Paid plan
requirement itself (Dynamic Workers' hard platform prerequisite) was independently confirmed for
this account without deploying — see REPORT.md.

## Drive it

```bash
npm install
npm run generate:types   # wrangler types
npm run dev              # wrangler dev, binds env.LOADER and env.TOOL_RUNNER locally

# In another terminal, allow-listed host (real network fetch, 200 + page body):
curl "http://localhost:8787/?url=https://example.com/"

# Non-allow-listed host (blocked by the EgressGateway before any real network fetch, 403):
curl "http://localhost:8787/?url=https://cloudflare.com/"
```

Automated coverage (the two testability sub-questions Spike C's aim states explicitly — see
`REPORT.md` Section 5):

```bash
npm test
```

## Files

- `src/index.ts` — the Worker's `fetch()` handler: obtains `ctx.exports.EgressGateway({})`, looks
  up the single `ToolRunner` Durable Object instance, and passes the gateway stub in as an RPC
  parameter.
- `src/tool-runner.ts` — `ToolRunner`, a minimal stand-in for the real demo's `ChatAgent` Durable
  Object. Its one RPC method probes whether `this.ctx.exports` is itself reachable inside a
  Durable Object method, then loads and runs the `getUrl` tool's Dynamic Worker via
  `this.env.LOADER.get()`.
- `src/egress-gateway.ts` — the `EgressGateway` `WorkerEntrypoint`: an allow-list gateway that
  logs every decision and is passed as a Dynamic Worker's `globalOutbound`.
- `src/get-url-tool-code.ts` — the sandboxed `getUrl` tool's own source, passed to
  `env.LOADER.get()` as a plain string (Dynamic Workers accept code as strings, not an imported
  module graph).
- `src/egress-gateway.test.ts` — a colocated unit test proving the gateway is testable by
  injecting a fake `fetch`, with zero real network traffic.
- `tests/worker-loader.test.ts` — a `@cloudflare/vitest-pool-workers` integration test proving the
  whole `ctx.exports` → Durable Object → `env.LOADER` → `globalOutbound` chain works inside the
  test pool, using a non-allow-listed host so no real network call happens inside the test run.

## What this spike does not do

No D1, no R2, no AI Gateway, no `AIChatAgent` — those are Spikes A/B/D/F and later phases. No
custom domain, no deployed Worker, no Cloudflare Access application (see above). The gateway's
allow-list is a single hard-coded `Set`, not configuration.
