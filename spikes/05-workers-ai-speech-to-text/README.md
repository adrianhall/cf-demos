# Spike E — Workers AI speech-to-text

**Aim** (docs/06-AGENTIC-CHAT.md, Phase 0, Spike E): confirm the exact input contract for a
Workers AI speech-to-text model (`@cf/openai/whisper-large-v3-turbo` or `@cf/deepgram/nova-3`)
called via `env.AI.run()` or `workers-ai-provider`'s `experimental_transcribe()` — required audio
encoding/format, base64 vs. binary input, maximum duration, and the exact output shape. Confirm a
browser's `MediaRecorder` default output (typically `audio/webm;codecs=opus`) is accepted directly
or needs client-side conversion, and record realistic latency for a roughly 10-second utterance.
See `REPORT.md` for what running it against the real account actually showed.

This is disposable spike code (AGENTS.md is not fully in force here; see
`docs/06-AGENTIC-CHAT.md`, Section 8 — "Spike Conventions"). It is exempt from the demo contract
(no custom domain, no `DEMO.md`/`EXPLAIN-DEMO.md`, no three-Vitest-project structure), but not
exempt from Cloudflare Access, because this account requires every Worker reachable over HTTPS —
including a bare `*.workers.dev` URL — to sit behind an Access application.

## Why this spike deploys, rather than staying local-only

Per Spike A's confirmed correction (docs/06-AGENTIC-CHAT.md, Section 8), `wrangler dev`'s
remote-binding proxy for `env.AI` cannot complete on this account at all — the proxy itself
depends on an account-level Cloudflare endpoint this account's Zero Trust posture gates behind
Access. `env.AI` has no local simulator either way (`docs/05-AI-CHAT.md`, "Workers AI Has No
Local Simulation"; `docs/DECISIONS.md` #9). This spike calls `env.AI.run()` directly, so — exactly
like Spike A, and unlike Spike C's `worker_loaders` binding, which needed no deployment at all —
it deploys for real and drives it over its own public hostname (Section 8's second bullet), which
needs the bypass-all Access application that bullet requires.

## How the Access application was created (and how to tear it down)

Mechanism 1 from Section 8 — a minimal, spike-scoped Terraform config (`infra/`), reusing the
`dotenv` provider against the repo root `.env` and the exact bypass-policy shape from AGENTS.md's
Public Access section, copied verbatim from `spikes/00-aichatagent-basics/infra/main.tf`. It
creates only a `cloudflare_zero_trust_access_policy` (`decision = "bypass"`, `include = [{
everyone = {} }]`) and a `cloudflare_zero_trust_access_application` fronting
`spike-05-workers-ai-speech-to-text.<account-workers-dev-subdomain>.workers.dev`. Terraform does
not own the Worker itself here — `wrangler deploy` does, per `wrangler.jsonc` in this directory.

This spike calls `env.AI.run()` with `gateway: { id: "default" }` — the one AI Gateway id that
auto-provisions on first use (Spike A's confirmed correction) — so, unlike Spike A, there is no
separate out-of-band AI Gateway resource to create or tear down for this spike specifically.

Create:

```bash
cd infra && terraform init && terraform apply -auto-approve
cd .. && npm install
npx wrangler deploy   # reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID from the repo root .env
```

Drive it (see REPORT.md for the actual results):

```bash
npm run probe -- --host spike-05-workers-ai-speech-to-text.<subdomain>.workers.dev
# or one fixture/mode at a time:
npm run probe -- --host <host> --fixture webm-opus --mode binding-base64
```

Tear down:

```bash
npx wrangler delete
cd infra && terraform destroy -auto-approve
```

## Files

- `src/index.ts` — `POST /transcribe?mode=<mode>`, comparing four call shapes against
  `@cf/openai/whisper-large-v3-turbo`/`@cf/openai/whisper`/`@cf/deepgram/nova-3`. See its own
  file-level JSDoc for exactly what each `mode` proves.
- `fixtures/utterance.webm` / `fixtures/utterance.wav` — the same ~12-second synthesized utterance
  (macOS `say` piped through `ffmpeg`) in two formats: `audio/webm;codecs=opus` (a real browser
  `MediaRecorder`'s actual default output format — not a hand-approximation, produced by ffmpeg's
  own `libopus`/`webm` muxer) and 16-bit PCM WAV (the client-side-converted alternative). This
  spike used synthesized speech rather than a live microphone recording only because no browser
  is available in this environment — the container format and codec are what matters for the
  question this spike answers, and both are produced by real encoders, not fabricated bytes.
- `wrangler.jsonc` — real config (not a template — no Terraform-generated values are wired in
  beyond the Worker name, which is a literal here, exactly like Spike A).
- `infra/main.tf` — the bypass Access application/policy only.
- `scripts/probe.mjs` — posts each fixture to each `mode` against the deployed Worker and prints
  the JSON result, including round-trip (`wallMs`) and model-call-only (`elapsedMs`) timings.

## What this spike does not do

No D1, no R2, no chat agent, no client UI, no AI Gateway dynamic routes (Spike B's job) — those
are later phases and later spikes. No unit/component tests were written per Section 8's "do not
write tests for a spike unless the test is what runs the spike" — `scripts/probe.mjs` run against
the real, deployed Worker *is* the test.
