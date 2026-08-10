# Spike — `docs/09B-ARCHITECT-MCP.md` Phase 11 (remote MCP mechanism, elkjs-in-`workerd`, OpenCode OAuth)

**Aim** (`docs/09B-ARCHITECT-MCP.md`'s [Phase 11 — Spike](../../docs/09B-ARCHITECT-MCP.md#phase-11---spike-tag-phase-11-mcp-spike)):
answer, before writing any Demo 9B feature code, the four open questions that phase lists:

1. Which mechanism is Cloudflare's current, blessed way to build a **stateless** remote MCP
   server — confirm or correct `createMcpHandler` (`agents/mcp/server`,
   `@modelcontextprotocol/server`), researched across the Cloudflare blog, `github.com/cloudflare`
   repositories, and the `@cloudflare` npm scope.
2. Is `createMcpHandler` still current against the latest Cloudflare Agents SDK docs?
3. Does `elkjs`'s layout algorithm run unmodified inside `workerd` (no DOM, no `Worker`/WASM
   dependency it cannot satisfy)?
4. What is OpenCode's current MCP OAuth client redirect behavior against Access Managed OAuth
   (loopback port, or a stable `allowed_uris` pattern)?

See `REPORT.md` for the full findings. Short version: (1)/(2) confirm the document's own
assumption with no correction needed; (3) is a **correction** — `elkjs` does not run inside
`workerd` today, so `docs/09B-ARCHITECT-MCP.md`'s planned `autoLayout()` MCP tool must ship the
grid-placement fallback that document already anticipated as a contingency; (4) narrows the
document's Access `oauth_configuration` guidance with OpenCode's actual, fixed default redirect
URI (`http://127.0.0.1:19876/mcp/oauth/callback`) and confirms it still uses Dynamic Client
Registration, not the newer Client ID Metadata Documents mechanism.

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions", which this repository's other spikes
already follow). It is exempt from the demo contract (no custom domain, no
`DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure).

## Why this spike stays entirely local — no Terraform, no Access application

Only question 3 (`elkjs` in `workerd`) needed runnable code, and it needed no inbound HTTPS
endpoint at all — `@cloudflare/vitest-pool-workers` boots a real, local `workerd` instance and
runs the test's own module code inside it directly. Per the Spike Conventions section's first
bullet ("a spike that never exposes an inbound HTTPS endpoint... needs neither Terraform nor an
Access application"), this spike needed no real-account footprint, and so there is nothing to tear
down. Questions 1, 2, and 4 were answered entirely by documentation/source research (Cloudflare
docs, the Cloudflare blog, npm registry metadata, and OpenCode's own compiled CLI binary and
published docs) — no code needed for those at all.

## Drive it

```bash
npm install
npm run test         # runs both elkjs-in-workerd probes against a real local workerd instance
npm run check:types  # tsc --noEmit
```

Both tests in `tests/` currently **pass** — they assert the *confirmed, current* (broken)
behavior as a regression canary, not the originally-hoped-for outcome. See `REPORT.md` for why.

## Files

- `tests/elkjs-layout.test.ts` — mirrors `demos/architect`'s real client-side auto-layout usage
  (`elkjs/lib/elk.bundled.js`, `layered`/`ORTHOGONAL` options) and confirms `new ELK()` throws
  synchronously inside `workerd`.
- `tests/elkjs-worker-factory.test.ts` — the follow-up probe: does supplying an explicit,
  directly-imported `workerFactory` work around the failure? Confirms a second, independent
  failure mode instead (the co-bundled `elk-worker.min.js` resolves to an empty module once
  re-bundled for `workerd`).
- `src/index.ts` — placeholder `fetch()` handler; exists only so Wrangler has a `main` module to
  boot `workerd` for the tests above. Never deployed.
- `wrangler.jsonc` — minimal config; the comment above `compatibility_date` records that
  `nodejs_compat` was tried too and made no difference.

## What this spike does not do

No MCP server code, no Durable Object, no Access application, no deployment. Questions 1, 2, and 4
are answered in `REPORT.md` directly from primary sources (cited inline) with no code artifact —
there was nothing to execute against the real Cloudflare account to answer them.
