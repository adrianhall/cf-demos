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
wants to do rather than after a model task type. The task type is in the panel's **About** modal, so
the panel teaches the vocabulary without putting a block of explanation above the thing a visitor
came to use.

| Panel              | Task type                    | Status            |
| ------------------ | ---------------------------- | ----------------- |
| **Chat**           | **Text generation**          | **Available now** |
| **Create Image**   | **Text to image**            | **Available now** |
| **Describe Image** | **Image to text**            | **Available now** |
| Remix Image        | Image to image               | Phase 6           |
| Classify Image     | Image classification         | Phase 7           |
| Create Video       | Text to video                | Phase 8           |
| Animate Image      | Image to video               | Phase 9           |
| Generate Music     | Text to music                | Phase 10          |
| Read Text          | Text to speech               | Phase 11          |
| Transcribe Audio   | Automatic speech recognition | Phase 12          |
| Translate Text     | Translation                  | Phase 13          |
| Classify Text      | Text classification          | Phase 14          |
| Evaluate Choices   | Structured evaluation        | Phase 15          |
| Semantic Search    | Text embeddings              | Phase 16          |
| **View Tokens**    | **Tokenization**             | **Available now** |

Panels that are not built yet are still listed, each stating the phase that delivers it. Hiding them
would misrepresent the product; a sidebar that quietly grows tells a visitor nothing about where the
work is going.

### Panel layout

The working panels put the activity ahead of the explanation:

- The **panel title is in the shell header**, beside an info button. That modal holds the technical
  task type, the summary, the gateway route, and the credit/privacy disclosure. The disclosure is
  not removed or softened — it is one click from the title instead of occupying the fold.
- The **input is centred** while there is nothing to compare it with. As soon as a media panel has
  output worth showing, it becomes the left column and the output appears on the right. On a narrow
  screen the columns stack in reading order: input first, output second.
- **Model settings are collapsed by default** beneath the input. Their summary always names the
  selected model, so the important fact remains visible while the controls are out of the way.
- **Run details are attached to Run output** through a second info button. Model, elapsed time,
  reported cost, token counts, cache state, and the gateway log identifier remain available without
  becoming a fifth equally-weighted section below the result.

Chat deliberately keeps its transcript layout — a conversation is one running sequence rather than
an input and a separate result — while sharing the title and About-modal pattern.

## Chat

The first panel that calls a model, and so the first that puts a figure in the session cost meter.
It streams its answer over server-sent events and shows what the request actually cost once AI
Gateway has written its log.

- **Two reviewed models** to compare: Llama 3.3 70B and Llama 3.2 3B. The same prompt against both
  shows that the larger model costs materially more per token and is not always the better value.
- **A familiar two-state chat interface.** The first visit centres one question box beneath
  suggested prompts. After the first send, the transcript starts at the top and the same composer
  stays at the bottom, with the model selector inside it. New chat returns to the welcome state
  without touching session cost totals.
- **Streaming output**, with the Send control becoming Stop without replacing the focused button.
  Stop aborts the HTTP request rather than merely ignoring what keeps arriving. A cancelled answer
  keeps the text it already generated, because that text was generated and paid for.
- **Sanitized Markdown answers.** Assistant headings, lists, links, tables, quotes, and code blocks
  render as formatted content through `marked` and a strict DOMPurify allowlist. User messages
  remain escaped text, and model output cannot render scripts, images, media, iframes, forms, or
  styles.
- **Run details** from an info button inside the composer: model, elapsed time, gateway log
  identifier, token counts, cache state, and the reported cost.
- **A truthful cost lifecycle.** The answer is never delayed waiting for a gateway log. The receipt
  arrives with `costStatus: pending`, the browser polls `GET /api/runs/:runId/metrics`, and the
  figure appears when the log does. If it never arrives, the panel says `Unavailable` rather than
  `$0.00`.
- **Prepared examples**, each demonstrating one thing: a repeatable question that shows the gateway
  cache on a second ask, a long answer that makes output-token billing visible, a token-heavy input
  of identifiers and timestamps, and a reasoning question worth running against both models.
- **A View Tokens handoff**, because a model bills by the token and this is where you can see what
  that means for your own text at no cost.

A run belongs to the identity that created it. Asking for another identity's run metrics is a `403`,
not an empty result — a blank answer would hide the attempt.

Ask the same question twice to see the gateway serve the second request from its cache: a real
answer that legitimately costs nothing new, labelled as such rather than as an unmeasured cost.

## Create Image

The panel that shows why a model's _contract_ matters more than its name. Its two reviewed models
disagree about almost everything, and the panel handles that honestly rather than hiding it behind a
single lowest-common-denominator form.

|          | FLUX.1 \[schnell]         | Stable Diffusion XL (beta)                                                 |
| -------- | ------------------------- | -------------------------------------------------------------------------- |
| Controls | prompt, steps (max **8**) | prompt, negative prompt, width, height, steps (max **20**), guidance, seed |
| Returns  | `{ image: "<base64>" }`   | a raw PNG byte stream                                                      |

That has two consequences the panel makes visible:

- **The form changes shape with the model.** Selecting FLUX.1 removes the negative prompt,
  dimensions, guidance, and seed, and lowers the step ceiling from 20 to 8. The controls are
  _absent_ rather than disabled, and a note says which model offers what — a disabled control
  invites "why can't I use this?", whereas an absent one plus an explanation answers it.
- **An unsupported control is refused, not ignored.** Asking FLUX.1 for a seed returns a `400`
  naming both the control and the model. Silently dropping it would teach you that the control did
  nothing, when the truth is that this model does not have it. Its input schema sets
  `additionalProperties: false`, so an extra field is a request the provider is entitled to reject
  outright — and its own catalog page shows an example passing a `seed` the schema does not permit.

Capabilities are declared per model in `src/worker/domain/models.ts` and published through
`/api/catalogue`, so the UI renders exactly the controls the server will accept. One definition
means a control cannot offer a value the API then refuses.

### Never trusting a declared content type

A generated image is identified by its **file signature**, never by what the provider called it.
This matters because the browser renders the result in a `data:` URI, and a `data:` URI's media type
decides how the payload is treated — `image/svg+xml` is a scripting context, not a picture. Only
PNG, JPEG, and WebP are accepted; markup, an HTML page, and a JSON error document returned under a
success status are all refused with a `502` before they can reach the page.

Media stays transient: no R2 bucket, no retention policy, and no cleanup step at teardown. The image
comes back base64-encoded in the JSON response rather than from a follow-up URL, because a URL would
require storing the bytes between two requests. An architecture test fails the build if a storage
binding is ever introduced to make a panel work.

### Comparing results

Each result is kept in a bounded in-browser gallery with the settings that produced it — model,
steps, size, guidance, seed — which is what makes it a comparison tool rather than a scrapbook. Two
images of one prompt at different step counts only teach something if you can see which was which,
and the run details beside them show what each one cost.

Alt text names the prompt an image was _generated from_ rather than asserting what it contains:
nothing in this panel has looked at the picture, and a diffusion model frequently does not produce
what was asked for. **Describe Image** is the separate panel that can actually inspect one.

## Describe Image

The reverse of Create Image in every dimension that matters. The request carries the megabytes and
the answer is a paragraph, the untrusted input is now a _file_, and the two reviewed models disagree
about something more fundamental than a slider range.

|            | LLaVA 1.5 7B (beta)             | Llama 3.2 11B Vision          |
| ---------- | ------------------------------- | ----------------------------- |
| A question | **Optional** — captions unasked | **Required** (`minLength: 1`) |
| Answer cap | 32–1,024 tokens, default 512    | 32–2,048 tokens, default 256  |
| Returns    | `{ description: "..." }`        | `{ response: "..." }`         |

Three consequences the panel makes visible:

- **Whether the panel can be submitted at all depends on the model.** Selecting Llama 3.2 Vision
  makes the question mandatory and the Describe button explains why it is disabled. Supplying a
  default question like "Describe this image" would have been friendlier and would have hidden a
  real contract difference — as well as putting words in the visitor's mouth.
- **The answer field is read from the reviewed descriptor, not guessed.** Trying `description`, then
  `response`, then any other string field would be more forgiving and considerably worse: a contract
  change would silently return some other field as the description. Insisting on the declared field
  turns that same break into a logged `502`.
- **The two defaults differ by a factor of two,** which a visitor sees as one model answering at
  roughly twice the length of the other for the same picture.

### The picture is whatever its bytes say it is

Nothing the browser claims about an upload is used. The format comes from the **file signature** and
the dimensions come from the **file header**, both read server-side, and a body that tries to
describe its own image — `mediaType`, `width`, `fileName` — is **rejected rather than ignored**, on
the same principle as an identity field. After a run the panel shows what the server established, so
a file named `.png` whose bytes are JPEG is visible rather than silently resolved.

Two limits rather than one, because they bound genuinely different costs:

- **1 MB**, which bounds _this Worker's_ memory, and is measured rather than chosen. Both reviewed
  models document their image field as a JSON array of one number per byte, and that expansion is
  brutally expensive: peak resident memory is ~55 MB for a 1 MiB picture, ~80 MB at 2 MiB, and
  **~234 MB at 4 MiB** — past the 128 MB an isolate gets. A larger ceiling would let one ordinary
  request exhaust the isolate and take unrelated requests down with it. It costs nothing in quality,
  because both models downscale heavily before they look at anything.
- **4,096 pixels on the longest edge**, which bounds the decode work the _provider_ does on our
  behalf. A flat-coloured image compresses to almost nothing while still being enormous to decode,
  so a file that passes the byte check can still be unreasonable. Neither limit subsumes the other.

Only PNG, JPEG, and WebP are accepted. SVG is excluded as a scripting context rather than a picture,
and GIF is excluded too: the list is an allowlist, not an "is it an image" check.

### Supplying a picture

Three routes — a file picker, drag-and-drop, and **paste** — all converging on one validation path.
Paste earns its place because a screenshot is the likeliest thing someone wants described, and
making them save it to disk first would be the slowest path to the thing the panel exists to do.

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
- **Assume your prompt is logged.** Each request sends `cf-aig-collect-log-payload: false`, which
  asks AI Gateway to record metrics without storing payloads — but the panels do **not** promise
  that your prompt is unretained, and neither does this README. AI Gateway's own documentation says
  a log "can include the prompt, response, provider, timestamp, status, token usage, cost,
  duration", payload storage is the platform's behaviour rather than this application's to
  guarantee, and the request header is not something the application can verify took effect. A
  privacy claim nobody can check is worth less than an honest warning, so each panel tells a visitor
  to treat it as any shared AI service and enter nothing confidential.
- **Your email _is_ recorded.** Every inference request attaches the verified Access email to its
  gateway metadata, so spending in a shared demo can be traced to the person who caused it. This is
  a deliberate departure from logging nothing personal, and the Activity page states it plainly
  before you send anything. It is the only personal field recorded.
- **Worker logs record neither.** Structured logs carry request identifiers, task and model
  identifiers, duration, and outcome — no prompts, no content, and not the email.

## Diagnosing a failure

A panel that fails has to be diagnosable from the logs alone, which takes more than a status code.
Every inference failure writes three things under one `runId`:

| Event                       | Written by                                | Carries                                                                                       |
| --------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `create_image_run_started`  | the route, **before** the model is called | run ID, model, which controls were set and to what, prompt _length_                           |
| `inference_provider_failed` | the inference client                      | the provider's own error message and type, the gateway log ID, the exact parameter names sent |
| `create_image_run_failed`   | the route                                 | the panel-level outcome, repeating the settings                                               |

Searching one run identifier therefore returns both what was asked for and what the provider said
about it. Two POSTs that look identical in an access log are distinguishable by their run ID and
their settings.

Three details make this work in practice:

- **The start line is written before the call**, so a request that fails inside the provider, times
  out, or is cancelled still leaves a record of having been attempted — which is exactly when
  knowing the parameters matters most.
- **`parameterNames` records what actually went on the wire.** The most common integration failure
  is sending a model a parameter its schema does not accept, and that list diagnoses it in one line.
- **A rejected output is distinguished from a provider error.** Both are a `502` to the browser, but
  `create_image_output_unusable` names the reason — `unrenderable_format`, `unrecognised_shape`,
  `too_large` — and logs the payload's leading bytes in hex, which is how you tell a GIF from a JSON
  error document without logging the payload.

The provider's message is logged server-side and **never** returned to the browser: it can carry
prompt fragments and internal endpoint names. An earlier version discarded it entirely, which made a
deployed `502` undiagnosable; an architecture test now fails the build if a `try` around a provider
call swallows its cause again.

## Authentication

The whole application is behind Cloudflare Access. There is **no application-level allowlist**:
anyone who can authenticate with the configured identity provider may use it, which is the point of
a demo you can hand to a colleague.

Authentication is there to attribute usage, not to gatekeep it. The Worker nonetheless validates the
JWT's signature, audience, and expiry itself as defence in depth: every Access application in a team
shares one JWKS, so without the audience check a token minted for an unrelated application would be
accepted here too.

### The gateway is authenticated too

`infra/playground.tf` sets `authentication = true`, which is a boundary Cloudflare Access does not
provide. A gateway's provider-native endpoint is reachable from the internet by anyone who learns
the account ID and the gateway's name, and with authentication off such a request **succeeds** —
spending this account's inference credit and inflating the log store the cost figures are read from.
That path never touches the Worker, so neither Access nor the Worker's own authorization sees it.

It costs this demo nothing, because requests that reach a gateway through a Worker's **AI binding
are pre-authenticated** by the account owning both. No token has to be minted, stored, or rotated
for the panels to keep working. The visible trade-off is that a `curl` against the gateway endpoint
now needs a token with `AI Gateway Run` — which is the entire point.

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
├── chat.ts          # Chat request and stream-event contracts, shared by both tiers
├── sse.ts           # Server-sent events framing, shared by both tiers
├── access-policies.ts
├── client/          # Vue 3 single-page application
│   ├── components/runs/   # Run details, shared by every inference panel
│   ├── composables/       # useRun: metrics polling, shared by every inference panel
│   ├── features/chat/     # Conversation state, transcript, examples
│   ├── services/          # The browser's only route to the API
│   └── stores/            # Session identity, model catalogue, cost ledger
└── worker/
    ├── index.ts     # Worker entry point and composition root
    ├── routes/      # Thin Hono/SSE handlers
    ├── middleware/  # Access, limits, errors
    ├── application/ # Use cases and ports
    ├── domain/      # Model descriptors, validation, cost rules, exception register
    └── infrastructure/
        ├── ai/      # The only module that talks to Workers AI
        └── runs/    # In-memory run records
```

`sse.ts` is shared because two different places parse the same wire format: the Worker parses what
Workers AI streams to it, and the browser parses the typed events the Worker streams onward. One
parser means they cannot drift apart.

Run records are held **in memory**, which is a design choice rather than a stopgap. A record exists
only to authorise and resolve a metrics lookup in the few seconds between an answer and its gateway
log propagating, and a Worker isolate comfortably outlives that. Adding KV or D1 would mean a
storage product, a Terraform resource, a teardown step, and a retention policy for data that is
worthless within a minute. The trade-off is visible and honest: if an isolate is recycled in
between, the metrics request answers `404` and the UI shows the cost as unavailable.

Every server-side tier lives under `src/worker/` because the Worker is both the Cloudflare runtime
entry point and the application's HTTP host; keeping them together makes the execution boundary
obvious and stops browser code importing Worker-only bindings. `src/worker/index.ts` is the
composition root and the only module allowed to depend on every tier — composing them is its single
responsibility.

`tasks.ts`, `runs.ts`, `chat.ts`, `sse.ts`, and `images.ts` sit at `src/` because they are genuinely
shared wire contracts. They contain types and constants only: no bindings, no secrets, no model
contracts. Model descriptors stay in the Worker's domain tier and reach the browser only through
`/api/catalogue` — which is how the browser learns each image model's control capabilities without
being able to decide them.

## API

| Route                          | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `GET /api/me`                  | The server's verified view of who you are.                                    |
| `GET /api/catalogue`           | Panels, reviewed models, and the gateway exception register.                  |
| `POST /api/chat/stream`        | Chat as server-sent events: `start`, `delta`, then `completed` or `problem`.  |
| `POST /api/create-image`       | Generates one image and returns it with its run receipt and applied controls. |
| `POST /api/describe-image`     | Describe a picture with a reviewed vision model.                              |
| `GET /api/runs/:runId/metrics` | Resolved or pending gateway cost for one of your own runs.                    |

Every route is behind Access, derives identity only from the verified JWT, and returns RFC 9457
`application/problem+json` on failure. More routes arrive with the panels that need them; there is
deliberately no generic `{ model, input }` passthrough.

Chat is `POST` rather than `GET`, which rules out `EventSource` on the client and is the right
trade: a prompt belongs in a request body, not in a URL that ends up in browser history, proxy logs,
and referrer headers.

Create Image is plain JSON rather than SSE, because there is nothing to stream: a diffusion model
returns one image at the end of its run, so streaming would add framing for a single payload without
giving a visitor earlier feedback than a spinner already does.

Describe Image is plain JSON too, and reverses the traffic: its request carries the picture and its
response is a paragraph. Its body limit is therefore derived from the image budget rather than
written separately, so the two cannot drift into a state where a picture the panel accepts is
refused by the transport. Both reviewed models can stream, but the answer is a short paragraph about
a picture already on screen.

A request body may not carry `user`, `email`, `actor`, `sub`, or `system`. Such a body is
**rejected** rather than having the field stripped, because stripping is a silent correction that
makes an attempt look like success and leaves nothing for a test to assert on. Describe Image
extends the same rule to fields that would describe its picture — `mediaType`, `width`, `fileName` —
since the server determines those from the bytes.

## Implementation status

Built to **phase 5** of
[`specs/playground/02-implementation.md`](../../specs/playground/02-implementation.md).

- **Phase 1** delivered the shell, the Terraform lifecycle, Access, the mandatory-gateway
  foundation, the shared contracts, and the test harness.
- **Phase 2** delivered View Tokens, the first usable panel.
- **Phase 3** delivered Chat: the first gateway-routed inference, streaming output, the run receipt
  and metrics lifecycle, and the first real figure in the session cost meter.
- **Phase 4** delivered Create Image: per-model control capabilities, byte-level media validation, a
  comparison gallery, and the first binary output.
- **Phase 5** delivered Describe Image: the first _uploaded_ media, header-level dimension limits,
  and per-model required/optional contracts.

Every other panel renders a placeholder stating the phase that delivers it. Remix Image, in phase 6,
is next.
