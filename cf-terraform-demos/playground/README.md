# Playground — an AI model playground where every request is observable

A single, authenticated web application for trying out AI model task types on Cloudflare: chat,
image generation and understanding, video, music, speech, translation, classification, structured
evaluation, embeddings, and tokenization.

Its point is not that it calls models. It is **how** it calls them: every inference request in this
application is routed through a Terraform-managed AI Gateway, and the cost of each one is read back
out of the gateway's log and shown to the person who caused it.

## The rule this demo exists to demonstrate

> Every inference request goes through AI Gateway. Not by default, not by convention — by
> construction.

Three mechanisms hold that up, because a rule nobody can check is a preference:

1. **One call site.** `src/worker/infrastructure/ai/gateway-inference-client.ts` is the only module
   that touches the Workers AI binding. It always passes the configured gateway and always asks for
   a log.
2. **A test that fails the build.** `tests/worker/gateway-isolation.test.ts` scans the source and
   fails if any other module references the binding.
3. **A three-way register.** A genuine exception must appear in the typed register, as a
   `NO_AI_GATEWAY:` annotation at the call site, and in
   [`AI-GATEWAY-EXCEPTIONS.md`](./AI-GATEWAY-EXCEPTIONS.md). `pnpm check:gateway` fails unless all
   three agree. **The register is currently empty.**

A gateway that can be skipped is not a control point, so the demo makes skipping it a build failure
rather than a code review conversation.

## Panels

The navigation is one level deep. Every panel is one click from anywhere, named after what a person
wants to do rather than after a model task type. The task type is shown underneath, so the panel
teaches the vocabulary instead of assuming it.

| Panel            | Task type                    | Status            |
| ---------------- | ---------------------------- | ----------------- |
| Chat             | Text generation              | Phase 3           |
| Create Image     | Text to image                | Phase 4           |
| Describe Image   | Image to text                | Phase 5           |
| Remix Image      | Image to image               | Phase 6           |
| Classify Image   | Image classification         | Phase 7           |
| Create Video     | Text to video                | Phase 8           |
| Animate Image    | Image to video               | Phase 9           |
| Generate Music   | Text to music                | Phase 10          |
| Read Text        | Text to speech               | Phase 11          |
| Transcribe Audio | Automatic speech recognition | Phase 12          |
| Translate Text   | Translation                  | Phase 13          |
| Classify Text    | Text classification          | Phase 14          |
| Evaluate Choices | Structured evaluation        | Phase 15          |
| Semantic Search  | Text embeddings              | Phase 16          |
| **View Tokens**  | **Tokenization**             | **Available now** |

Panels that are not built yet are still listed, each stating the phase that delivers it. Hiding them
would misrepresent the product; a sidebar that quietly grows tells a visitor nothing about where the
work is going.

## View Tokens

The one panel that performs no inference at all. It tokenizes in your browser, contacts no model,
produces no gateway log, and costs nothing — which is why it is explicitly _not_ an entry in the
exception register: there is no request to route anywhere. It also means the panel works offline.

It shows what a model would actually charge you for:

- **Coloured token boxes**, separated by outline and spacing as well as colour, with the whitespace
  made visible. The surprise for most people is that a leading space belongs to the word that
  follows it, so `gateway` and ` gateway` are different tokens.
- **Live counts** — tokens, characters, words, characters per token, and the proportion of a
  reference context window. The familiar "about four characters per token" is an English-prose
  average, and the panel makes its failure on code, other scripts, and emoji immediately visible.
- **A token table** with each token's exact escaped text and its vocabulary identifier, which is
  also the non-visual equivalent of the coloured sequence.
- **Four encodings** to compare. The same Japanese sentence costs 18 tokens under `o200k_base` and
  27 under `gpt2`: a real difference in what that sentence costs to send.
- **Prepared examples**, each chosen to demonstrate one counter-intuitive property: leading spaces,
  source code, long numbers, non-English scripts, and emoji.

Tokenizers are lazily loaded, so the shell does not ship four vocabulary tables to someone who never
opens the panel. Each tokenizer states which models it is exact for; a count presented without
naming its tokenizer is a number people will quote.

## Cost and privacy

- **Cost comes only from AI Gateway logs.** The browser never estimates a price from token counts.
- **A missing cost stays missing.** The UI shows `Pending`, `Unavailable`, or `Not applicable` and
  never substitutes `$0.00`. A free-looking run and an unmeasured run are different claims.
- **Pricing units are not all tokens.** Music bills per track, speech per second of audio. The
  session meter labels the unit rather than implying the numbers are comparable.
- **Prompts and output are not retained.** Each request sends `cf-aig-collect-log-payload: false`,
  so the gateway records metrics without storing what you typed or what came back.
- **Your email _is_ recorded.** Every inference request attaches the verified Access email to its
  gateway metadata, so spending in a shared demo can be traced to the person who caused it. This is
  a deliberate departure from logging nothing personal, and the Activity page states it plainly
  before you send anything. It is the only personal field recorded.
- **Worker logs record neither.** Structured logs carry request identifiers, task and model
  identifiers, duration, and outcome — no prompts, no content, and not the email.

## Authentication

The whole application is behind Cloudflare Access. There is **no application-level allowlist**:
anyone who can authenticate with the configured identity provider may use it, which is the point of
a demo you can hand to a colleague.

Authentication is there to attribute usage, not to gatekeep it. The Worker nonetheless validates the
JWT's signature, audience, and expiry itself as defence in depth: every Access application in a team
shares one JWKS, so without the audience check a token minted for an unrelated application would be
accepted here too.

## Prerequisites

1. A Cloudflare account with Workers, AI Gateway, Workers AI, and Zero Trust.
2. A DNS zone hosted on Cloudflare.
3. Node.js 26+, pnpm 12.6+, and Terraform 1.10+.
4. A repository-root `.env`, created by `pnpm create-env` at the repository root. This demo needs
   its API token to carry, in addition to the repository baseline:
   - **Account**: AI Gateway — Edit
   - **Account**: Workers AI — Edit
   - **Account**: Workers Scripts — Edit
   - **Account**: Access — Edit
   - **Zone**: DNS — Edit
5. For third-party catalog models (from Phase 4 onwards), AI Gateway
   [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) credit
   on the account. Workers AI models need the Workers Paid plan.

There is no `.dev.vars` file and no per-demo `.env`.

## Local development

```bash
pnpm install        # from the repository root
pnpm start          # in this directory
```

`pnpm start` runs `cf dev` with local state persistence. Cloudflare Access is **emulated rather than
disabled**, so local development exercises the identical policy list, audience check, and identity
plumbing the deployed Worker uses. Sign in as `alice@example.com` or `bob@example.com`; switching
between them is how the demo's per-user attribution is demonstrated and tested.

Local runs read committed placeholder values from `infra/local-outputs.json`, so nothing touches
live Terraform state.

## Commands

| Command         | What it does                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm start`    | Run locally against local simulations, with Access emulated.                                      |
| `pnpm check`    | Types, formatting, type-aware lint, gateway register, Terraform validate and fmt. Writes nothing. |
| `pnpm fix`      | Apply formatting, safe lint fixes, and Terraform fmt.                                             |
| `pnpm test`     | Domain, Worker, client DOM, and Workers-runtime suites. Fully offline.                            |
| `pnpm deploy`   | Terraform apply, then build and upload the Worker.                                                |
| `pnpm teardown` | Delete the Worker, then destroy the infrastructure.                                               |

Every step is individually runnable (`pnpm check:lint`, `pnpm deploy:infra`, and so on).

## Deployment and teardown

```bash
pnpm deploy
pnpm teardown
```

Terraform owns the AI Gateway, the Worker registration and its bootstrap deployment, the custom
hostname, and the Access application and policy. `cf` owns the Worker code and its deploy-time
bindings. Exactly one owner per resource.

`pnpm teardown` deletes the Worker **before** destroying infrastructure, in that order on purpose:
Cloudflare refuses to delete a gateway that a deployed Worker is still bound to, and the AI binding
is attached by `cf` rather than Terraform. The explicit `depends_on` from the Worker to the gateway
makes Terraform's own destroy order safe for the same reason.

## Architecture

```text
Vue UI  →  routes  →  application  →  domain / infrastructure
```

```text
src/
├── tasks.ts         # Panel catalogue, shared by both tiers
├── runs.ts          # Run, receipt, and cost contracts, shared by both tiers
├── access-policies.ts
├── client/          # Vue 3 single-page application
└── worker/
    ├── index.ts     # Worker entry point and composition root
    ├── routes/      # Thin Hono handlers
    ├── middleware/  # Access, limits, errors
    ├── application/ # Use cases and ports
    ├── domain/      # Model descriptors, exception register
    └── infrastructure/
        └── ai/      # The only module that talks to Workers AI
```

Every server-side tier lives under `src/worker/` because the Worker is both the Cloudflare runtime
entry point and the application's HTTP host; keeping them together makes the execution boundary
obvious and stops browser code importing Worker-only bindings. `src/worker/index.ts` is the
composition root and the only module allowed to depend on every tier — composing them is its single
responsibility.

`tasks.ts` and `runs.ts` sit at `src/` because they are genuinely shared wire contracts. They
contain types and constants only: no bindings, no secrets, no model contracts. Model descriptors
stay in the Worker's domain tier and reach the browser only through `/api/catalogue`.

## API

| Route                | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `GET /api/me`        | The server's verified view of who you are.                   |
| `GET /api/catalogue` | Panels, reviewed models, and the gateway exception register. |

Every route is behind Access, derives identity only from the verified JWT, and returns RFC 9457
`application/problem+json` on failure. More routes arrive with the panels that need them; there is
deliberately no generic `{ model, input }` passthrough.

## Implementation status

Built to **phase 2** of
[`specs/playground/02-implementation.md`](../../specs/playground/02-implementation.md).

- **Phase 1** delivered the shell, the Terraform lifecycle, Access, the mandatory-gateway
  foundation, the shared contracts, and the test harness.
- **Phase 2** delivered View Tokens, the first usable panel.

Every other panel renders a placeholder stating the phase that delivers it. Chat, in phase 3, will
be the first to call a model and the first to put a figure in the session cost meter.
