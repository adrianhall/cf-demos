# Spike D — Skills mechanism compatible with `AIChatAgent`

**Aim** (docs/06-AGENTIC-CHAT.md, Phase 0, Spike D): determine whether the Agents SDK's released
**Agent Skills** mechanism (`agents/skills`'s `SkillRegistry` + `r2()` source,
`activate_skill`/`read_skill_resource` tools) can be attached to an `AIChatAgent`-based chat's own
`streamText()` call, or whether it is usable only through `@cloudflare/think`'s `Think` class. If
composable, prove a minimal example loading one R2-backed skill into an `AIChatAgent` tool set. See
`REPORT.md` for what running it actually showed — the mechanism composes, but only once a real,
non-obvious `SkillRegistry` usage bug this spike hit is avoided; `docs/06-AGENTIC-CHAT.md`'s
Alternatives table has been updated to prefer the released mechanism over the hand-rolled design it
previously specified as the fallback.

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions"). It is exempt from the demo contract
(no custom domain, no `DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure).

## Why this spike deploys, rather than staying local-only

Per Spike A's finding (`docs/DECISIONS.md` #11), this account's Zero Trust posture blocks
`wrangler dev`'s remote-binding proxy for `env.AI`, so any spike exercising a live tool-calling
`streamText()` turn needs a real deployment driven over its own public hostname (Section 8's
second bullet), which needs the bypass-all Access application that bullet requires.

## How the Access application was created (and how to tear it down)

Mechanism 1 from Section 8 — a minimal, spike-scoped Terraform config (`infra/`), reusing the
`dotenv` provider against the repo root `.env` and the exact bypass-policy shape from AGENTS.md's
Public Access section, verbatim from Spike A's own `infra/main.tf`. It creates only a
`cloudflare_zero_trust_access_policy` (`decision = "bypass"`, `include = [{ everyone = {} }]`) and
a `cloudflare_zero_trust_access_application` fronting
`spike-03-agent-skills-composability.<account-workers-dev-subdomain>.workers.dev`. Terraform does
not own the Worker or the R2 bucket here — `wrangler deploy`/`wrangler r2 bucket create` do.

Create:

```bash
cd infra && terraform init && terraform apply -auto-approve
cd ..
npm install
npx wrangler types
npx wrangler r2 bucket create spike-03-agent-skills
npx wrangler r2 object put "spike-03-agent-skills/skills/cloudflare-spike-fact/SKILL.md" \
  --file="fixtures/skills/cloudflare-spike-fact/SKILL.md" --remote
npx wrangler r2 object put "spike-03-agent-skills/skills/cloudflare-spike-fact/references/passphrase.md" \
  --file="fixtures/skills/cloudflare-spike-fact/references/passphrase.md" --remote
npx wrangler deploy   # reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from the repo root .env
```

Drive it (same wire-protocol probe pattern as Spike A's `scripts/probe.mjs`):

```bash
node scripts/probe.mjs --host spike-03-agent-skills-composability.<subdomain>.workers.dev \
  --message "What is the spike passphrase?"      # matches the fixture skill
node scripts/probe.mjs --host spike-03-agent-skills-composability.<subdomain>.workers.dev \
  --message "What is 12 times 7?"                 # does not match any skill
```

Tear down (run all three):

```bash
npx wrangler delete
npx wrangler r2 object delete spike-03-agent-skills/skills/cloudflare-spike-fact/SKILL.md --remote
npx wrangler r2 object delete spike-03-agent-skills/skills/cloudflare-spike-fact/references/passphrase.md --remote
npx wrangler r2 bucket delete spike-03-agent-skills
cd infra && terraform destroy -auto-approve
```

## Files

- `src/index.ts` — the `ChatAgent` (`AIChatAgent` subclass), backed by a single R2-sourced
  `SkillRegistry`, and the Worker's custom routing (reused verbatim from Spike A).
- `fixtures/skills/cloudflare-spike-fact/` — one fixture skill (a `SKILL.md` plus one on-demand
  resource file) uploaded to R2 for `agents/skills`'s `r2()` source to discover.
- `wrangler.jsonc` — real config (not a template). Adds an `r2_buckets` binding and the
  `CHAT_AGENT` Durable Object binding to Spike A's shape; no `worker_loaders` binding is needed —
  this spike never runs a skill script (`run_skill_script`, gated behind a `scriptRunner` this
  spike never provides).
- `infra/main.tf` — the bypass Access application/policy only, adapted from Spike A's.
- `scripts/probe.mjs` — the same `AIChatAgent` WebSocket wire-protocol probe Spike A wrote, with
  `--model` removed (this spike has one model) and its part-type regex widened to capture
  underscored tool part types (`tool-input-start`, etc.).

## What this spike does not do

No D1, no R2 file-attachment tools (`writeMarkdown`/`getUrl` — those are Phases 9/10 and Spikes C/
already-answered), no dynamic AI Gateway routes (Spike B), no cost ledger (Spike F), no
`run_skill_script` (needs a `worker_loaders`-backed `scriptRunner`, Spike C's mechanism — this
spike only proves `activate_skill`/`read_skill_resource`, the two tools that exist unconditionally).
No unit/component tests were written per Section 8's "do not write tests for a spike unless the
test is what runs the spike" — `scripts/probe.mjs` run against the real, deployed Worker for both
a skill-matching and a non-matching prompt *is* the test.
