# Spike A — `AIChatAgent` + Workers AI + AI Gateway, end to end

**Aim** (docs/06-AGENTIC-CHAT.md, Phase 0, Spike A): prove the minimal working chain — an
`AIChatAgent` subclass, one Durable Object per chat name, `onChatMessage` calling the `ai` SDK's
`streamText()` with `workers-ai-provider`'s `createWorkersAI({ binding: env.AI })`, a model
routed through an AI Gateway binding, streamed to a client over WebSocket — and confirm every
open question the scenario doc lists under Spike A before any feature phase is built on top of
an assumption. See `REPORT.md` for what running it against the real account actually showed
(several findings corrected an assumption in `docs/06-AGENTIC-CHAT.md`, which has been updated).

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions"). It is exempt from the demo contract
(no custom domain, no `DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure), but not
exempt from Cloudflare Access, because this account requires every Worker reachable over HTTPS —
including a bare `*.workers.dev` URL — to sit behind an Access application.

## Why this spike deploys, rather than staying local-only

Section 8 lets a spike with no inbound HTTPS endpoint skip Terraform and Access entirely (pure
`wrangler dev`/`vitest-pool-workers` against local or remote bindings). That was the original
plan here, since `env.AI` only ever needs `wrangler dev`'s remote-binding proxy, not a public
deployment. In practice, on this account, `wrangler dev`'s "Establishing remote connection…" step
for the `ai` binding could not complete at all — the remote-binding proxy itself depends on an
account-level Cloudflare endpoint that this account's Zero Trust/SASE posture gates behind Access,
so a purely local session had no way to authenticate through it. This spike therefore deploys for
real and drives it over its own public hostname (Section 8's second bullet), which needs the
bypass-all Access application that bullet requires.

## How the Access application was created (and how to tear it down)

Mechanism 1 from Section 8 — a minimal, spike-scoped Terraform config (`infra/`), reusing the
`dotenv` provider against the repo root `.env` and the exact bypass-policy shape from AGENTS.md's
Public Access section. It creates only a `cloudflare_zero_trust_access_policy` (`decision =
"bypass"`, `include = [{ everyone = {} }]`) and a `cloudflare_zero_trust_access_application`
fronting `spike-00-aichatagent-basics.<account-workers-dev-subdomain>.workers.dev`. Terraform does
not own the Worker itself here — `wrangler deploy` does, per `wrangler.jsonc` in this directory.

Create:

```bash
cd infra && terraform init && terraform apply -auto-approve
cd .. && npm install
npx wrangler types
npx wrangler deploy   # reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from the repo root .env
```

Drive it:

```bash
node scripts/probe.mjs --host spike-00-aichatagent-basics.<subdomain>.workers.dev \
  --model reasoning|non-reasoning [--chat <id>] [--message "..."]
```

Tear down (run all three — see REPORT.md for why the AI Gateway step is separate):

```bash
npx wrangler delete
cd infra && terraform destroy -auto-approve
# AI Gateway created out-of-band for this spike (Section 8: "manually remove any AI Gateway...
# resource the spike created that Terraform will not later own"):
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways/spike-00-aichatagent-basics" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

## Files

- `src/index.ts` — the `ChatAgent` (`AIChatAgent` subclass) and the Worker's custom routing.
- `wrangler.jsonc` — real config (not a template — this spike has no Terraform-generated values
  wired into it beyond the Worker name, which is a literal here, not an output).
- `infra/main.tf` — the bypass Access application/policy only.
- `scripts/probe.mjs` — a Node script speaking the `AIChatAgent` WebSocket wire protocol directly
  (see REPORT.md), used in place of `agents/react`'s `useAgentChat` (React-only) or a browser.

## What this spike does not do

No D1, no R2, no tools, no skills, no dynamic routes, no cost ledger — those are later phases and
later spikes (B–F). No unit/component tests were written per Section 8's "do not write tests for
a spike unless the test is what runs the spike" — `scripts/probe.mjs` run against the real,
deployed Worker *is* the test.
