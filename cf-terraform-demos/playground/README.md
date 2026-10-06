# Playground — an AI model playground where every request is observable

A single, authenticated web application for trying out AI model task types on Cloudflare: chat,
image generation and understanding, video, music, speech, translation, classification, structured
evaluation, embeddings, and tokenization.

Its point is not that it calls models. It is **how** it calls them: inference routes through a
Terraform-managed AI Gateway unless a reviewed platform limitation is recorded in the explicit
exception register. Gateway-reported cost is shown when a Gateway log exists; an exception stays
visibly uncosted rather than pretending to be free.

## The rule this demo exists to demonstrate

> Every gateway-compatible inference request goes through AI Gateway. A bypass exists only for a
> registered, documented platform limitation.

Three mechanisms hold that up, because a rule nobody can check is a preference:

1. **One call site.** `src/worker/infrastructure/ai/gateway-inference-client.ts` is the only module
   that touches the Workers AI binding. It passes the configured gateway and asks for a log unless
   the exact operation has a checked `NO_AI_GATEWAY` annotation.
2. **A test that fails the build.** `tests/worker/gateway-isolation.test.ts` scans the source and
   fails if any other module references the binding.
3. **A three-way register.** A genuine exception must appear in the typed register, as a
   `NO_AI_GATEWAY:` annotation at the call site, and in
   [`AI-GATEWAY-EXCEPTIONS.md`](./AI-GATEWAY-EXCEPTIONS.md). `pnpm check:gateway` fails unless all
   three agree. **The register currently contains the Cloudflare-hosted FLUX.2 multipart-stream
   exception.**

A gateway that can be skipped is not a control point, so the demo makes skipping it a build failure
rather than a code review conversation.

## Panels

The navigation is one level deep. Every panel is one click from anywhere, named after what a person
wants to do rather than after a model task type. The task type is in the panel's **About** modal, so
the panel teaches the vocabulary without putting a block of explanation above the thing a visitor
came to use.

The sidebar's group headings — Generate, Understand, Speech, Reason, Inspect — are disclosures. Each
can be collapsed to narrow the list, and an expand-all/collapse-all pair at the top of the
navigation drives all five at once. The collapsed set persists across reloads so a presenter can
tidy the sidebar before a demo. This is a view preference, not a level of navigation: a group is
never a destination, every panel keeps its own top-level route, and expand-all restores the full
list in a single click.

| Panel                | Task type                        | Status            |
| -------------------- | -------------------------------- | ----------------- |
| **Chat**             | **Text generation**              | **Available now** |
| **Create Image**     | **Text to image**                | **Available now** |
| **Describe Image**   | **Image to text**                | **Available now** |
| **Remix Image**      | **Image to image**               | **Available now** |
| **Classify Image**   | **Image classification**         | **Available now** |
| **Detect Objects**   | **Object detection**             | **Available now** |
| **Create Video**     | **Text to video**                | **Available now** |
| **Animate Image**    | **Image to video**               | **Available now** |
| **Generate Music**   | **Text to music**                | **Available now** |
| **Read Text**        | **Text to speech**               | **Available now** |
| **Transcribe Audio** | **Automatic speech recognition** | **Available now** |
| **Translate Text**   | **Translation**                  | **Available now** |
| **Classify Text**    | **Text classification**          | **Available now** |
| **Evaluate Choices** | **Structured evaluation**        | **Available now** |
| **Semantic Search**  | **Text embeddings / reranking**  | **Available now** |
| **View Tokens**      | **Tokenization**                 | **Available now** |

Every panel in the catalogue is built, so the "not built yet" placeholder that carried the sidebar
through staged delivery has been removed along with the phase pill that announced it. A panel listed
without a view behind it is now a build error rather than something a visitor can reach.

Each panel instead carries a mark for who runs its models: the Cloudflare logo when at least one
Cloudflare-hosted model is available, and a **3P** mark when at least one third-party model is. Both
appear where both apply. The distinction is a practical one rather than a branding one — a
third-party model bills against Unified Billing credits, so the three panels showing only the 3P
mark (Create Video, Animate Image, Generate Music) do nothing at all on an account with no prepaid
AI credits. The marks say so before a visitor tries them.

The flags live on the task descriptor rather than being read from `/api/catalogue`, so the sidebar
renders without waiting on a fetch. Because that is a copy of something the model registry already
knows, tests assert in both directions that it still matches `modelsForTask()` — at the unit level
and against a live `/api/catalogue` response — so a badge cannot drift from the models actually
offered.

### Panel layout

The working panels put the activity ahead of the explanation:

- The **panel title is in the shell header**, beside an info button. That modal holds the technical
  task type, the summary, the gateway route, and the credit/privacy disclosure. The disclosure is
  not removed or softened — it is one click from the title instead of occupying the fold.
- The **input is centred** while there is nothing to compare it with. As soon as a media panel has
  output worth showing, it becomes the left column and the output appears on the right. On a narrow
  screen the columns stack in reading order: input first, output second.
- **Model settings are collapsed by default** beneath the input. Their summary always names the
  selected model, so the important fact remains visible while the controls are out of the way. The
  expanded block gives the full, copyable model ID — including `@cf/` — and updates it immediately
  when the dropdown changes. IDs stay out of native option labels because those cannot wrap; on a
  narrow panel the distinguishing tail would be the first part hidden.
- **Run details are attached to Run output** through a second info button. Model, elapsed time,
  reported cost, token counts, cache state, and the gateway log identifier remain available without
  becoming a fifth equally-weighted section below the result.

Chat deliberately keeps its transcript layout — a conversation is one running sequence rather than
an input and a separate result — while sharing the title and About-modal pattern.

## Chat

The first panel that calls a model, and so the first that puts a figure in the session cost meter.
It streams its answer over server-sent events and shows what the request actually cost once AI
Gateway has written its log.

- **Eight reviewed models** to compare, spanning a roughly 30× price spread and context windows from
  24,000 to 1,048,576 tokens. The same prompt against Llama 3.3 70B and Llama 3.2 3B shows that the
  larger model costs materially more per token and is not always the better value; GLM-5.3 Flash
  against GLM-5.3 makes the same point more sharply, because the two share a contract and a
  million-token window and differ in input price by roughly nine times.
- **Five of the eight reason, and the transcript stays clean anyway.** A reasoning model emits an
  internal monologue as well as an answer. These five put it in
  `choices[0].delta.reasoning_content`, which the stream parser never reads — so reasoning is
  discarded by construction rather than by suppression code. Two catalogue models that leak their
  monologue into the rendered field are deliberately excluded; see
  [`MODEL-EXCLUSIONS.md`](./MODEL-EXCLUSIONS.md).
- **A familiar two-state chat interface.** The first visit centres one question box beneath
  suggested prompts. After the first send, the transcript starts at the top and the same composer
  stays at the bottom, with the model selector and the active model's full ID inside it. New chat
  returns to the welcome state without touching session cost totals.
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

The panel that shows why a model's _contract_ matters more than its name. Its six reviewed models
disagree about almost everything, and the panel handles that honestly rather than hiding it behind a
single lowest-common-denominator form.

|                         | Controls                                                                   | Returns                 |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------- |
| **FLUX.1 \[schnell]**   | prompt, steps (max **8**)                                                  | `{ image: "<base64>" }` |
| **Stable Diffusion XL** | prompt, negative prompt, width, height, steps (max **20**), guidance, seed | a raw PNG byte stream   |
| **SDXL Lightning**      | identical to Stable Diffusion XL                                           | a raw **JPEG** stream   |
| **DreamShaper 8 LCM**   | identical to Stable Diffusion XL                                           | a raw PNG byte stream   |
| **Phoenix 1.0**         | as above, but steps to **50** and guidance starting at **2**               | a raw JPEG stream       |
| **Lucid Origin**        | as above, **no negative prompt**, up to **2,500px**, default 1,120         | `{ image: "<base64>" }` |

Three of these are worth selecting deliberately:

- **SDXL Lightning against Stable Diffusion XL** is the panel's one controlled comparison. The
  request is byte-for-byte identical, so the only variable is the model — which is what makes the
  latency difference attributable to it. It also returns JPEG where its twin returns PNG, and
  nothing in the demo was changed to cope: the media type is sniffed from the returned bytes.
- **Phoenix 1.0** is the only model whose guidance range does not start at zero. A value every other
  model accepts is invalid here, which is precisely why ranges are declared per model.
- **Lucid Origin** publishes a 2,500-pixel ceiling and a 1,120-pixel default — neither a power of
  two. Both look like typos and both are what its schema says.

**DreamShaper 8 LCM publishes no price at all**, and it is registered anyway. Create Image never
estimates before a run; it reports what AI Gateway logged afterwards. An unpriced model is therefore
honest here in a way it would not be on Transcribe Audio, whose whole selector is a cost comparison.

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

|            | LLaVA 1.5 7B                    | Llama 3.2 11B Vision          |
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

## Classify Image

The first panel whose model is not generative. A classifier does not write a sentence about a
picture; it scores it against the fixed list of categories it was trained on and returns a number
for each. The reviewed model is **ResNet-50**, the catalogue's only Cloudflare-hosted image
classifier, and its contract is the narrowest in the demo: its schema is `{ image: number[] }` and
nothing else, and its output is a bare array of `{ label, score }`.

Three things follow from that, and the panel is shaped around them.

### The controls are applied to the answer, not sent with the question

The model accepts no top-k and no confidence threshold, so those two controls act on the response
after it arrives. The panel says so — "this model takes no ranking parameters" — rather than letting
a slider imply the model was asked to filter. The distinction is recorded in the model descriptor as
`appliedBy: 'playground'`, so a model that _does_ accept ranking fields would describe itself
differently instead of inheriting the wrong sentence.

It also changes what the result heading can honestly say. "Showing 3 of the 5 labels this model
returned" is true; "top 3" would imply a request that was never made. Forwarding the controls anyway
would send the provider fields its schema does not declare, which is the most common integration
failure there is.

Ordering, the confidence floor, and the truncation therefore live in the **domain** layer rather
than in a Vue component, so every transport gets the same behaviour. Two details there are decided
rather than incidental: the floor is applied **before** the limit, so "top 5 above 0.1" means the
five best labels that clear the floor; and ties are broken by label name, because a classifier
returning two identical scores is ordinary and an unstable order would make the same picture rank
differently between runs.

Nothing is rescaled after filtering. A set of scores that no longer sums to anything meaningful is
the honest consequence of hiding some, and renormalising would invent output the model never
produced.

### A score is not a probability of being correct

A confidence bar is extremely good at implying otherwise, so the panel states what the number is in
three places: in the **About** dialog, beside the controls, and immediately above the ranking. The
score means the picture resembles that category's training data. It is not the chance the label is
right, and it says nothing at all about whether the correct category is even in the model's label
set — a picture of something ImageNet has no category for still produces a confident-looking
ranking. One of the prepared examples exists specifically to show that.

An architecture test enforces the claim rather than leaving it to review: no panel may say a score
is the probability a label is correct, and a panel that renders scores must say what they actually
are. The guard is written against every panel, because Classify Text and Semantic Search render the
same shape in later phases and will face the same temptation.

### The ranking is readable without the bars

The result is a real `table` — rank, label, score — rather than a list of styled divs. The data is
genuinely tabular, and a table gives a screen-reader user row and column context and a row count for
free. The label is the row header, so a score is announced with the label it belongs to instead of
as a bare percentage.

Each bar lives _inside_ the score cell beside the number rather than replacing it, and is
`aria-hidden`: it repeats a value that is already there as text, so announcing it would read the
same number twice. The test for this deletes every bar from the rendered output and asserts that
nothing was lost. In forced-colours mode the bars keep a visible border and use the system highlight
colour, so the comparison survives a theme that discards the palette.

The full-precision scores stay available in a collapsed **Structured response** disclosure, so the
table is the result and the raw JSON is reference material rather than the dominant content.

An empty ranking is treated as a real outcome of a successful run — the model answered and the
visitor's floor hid all of it — and the panel says which, rather than rendering the same emptiness
as "no result yet".

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
- **This application's log lines record neither.** Its structured logs carry request identifiers,
  task and model identifiers, duration, and outcome — no prompts, no content, and not the email. The
  wording is deliberately "this application's" rather than "the logs": a Workflow log line also
  carries a platform-written `$workers.instanceId`, which for the two video panels is a per-run
  value derived from the verified email. It cannot be grouped across a visitor's runs or reversed to
  an address, but it is not nothing, and claiming the log as a whole holds nothing identifying would
  be a claim this demo is not in a position to keep. See
  [The derived identifier is in the logs](#the-derived-identifier-is-in-the-logs-and-that-was-a-decision).

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

### The same convention in every panel

Create Image is the example above, but the shape is identical in all fifteen inference panels:
`<task>_run_started` before the call, `<task>_run_failed` after it, and `runId` as the correlation
field in both. That consistency is what makes a cross-panel log search possible, and it is enforced
rather than merely intended — a contract test driven from the task catalogue asserts every delivered
panel follows it, so a panel added later is covered the moment it is marked available.

The failure mode that test exists for is subtle. A panel spelling the field `run_id` would log
correctly, read correctly, and pass every test it had of its own, while falling out of every search
that joins panels together. The search would still return results — just not all of them, which is
considerably worse than returning none. The test therefore asserts the _absence_ of alternative
spellings as well as the presence of the right one.

Phase 18's audit found exactly one gap, and it was in the oldest panel: Chat had no start line. It
was written before the rule existed and never retrofitted, which left the hole in the worst place —
Chat is the only panel that streams, so a connection dropped mid-answer ends the request without
reaching either terminal log line.

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
5. For third-party catalog models, including Remix Image's P-Image-Edit and Nano Banana 2, prepaid
   AI Gateway
   [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) credits
   must be loaded on the account. A configured payment method alone is not sufficient: confirm the
   **Credits Available** card has a positive balance before running the panel. Workers AI models use
   the account's configured Workers AI billing mode.

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
├── access-policies.ts     # One policy list, used by the Worker and by the dev-mode Vite plugin
├── shared/                # Wire contracts both tiers import: one per panel, plus the three below
│   ├── tasks.ts           # Panel catalogue
│   ├── runs.ts            # Run, receipt, and cost contracts
│   └── sse.ts             # Server-sent events framing
├── client/                # Vue 3 single-page application
│   ├── components/        # Shared presentation: run details, media players, result tables
│   ├── composables/       # useRun: metrics polling, shared by every inference panel
│   ├── features/          # Per-panel state and presentation, one directory per panel
│   ├── services/          # The browser's only route to the API
│   ├── stores/            # Session identity, model catalogue, cost ledger
│   └── views/             # One view per panel, routed directly
└── worker/
    ├── index.ts           # Worker entry point, composition root, and the scheduled reaper
    ├── routes/            # Thin Hono/SSE handlers
    ├── middleware/        # Access, limits, errors
    ├── application/       # Use cases and ports, one directory per panel
    │   ├── media/         # The scheduled video reaper
    │   └── ports/         # The interfaces the application tier depends on
    ├── domain/            # Model descriptors, validation, cost rules, exception register
    └── infrastructure/
        ├── ai/            # The only module that talks to Workers AI
        ├── embeddings/    # In-isolate embedding cache
        ├── jobs/          # The two Workflows and their shared job adapter
        ├── media/         # Provider media clients and R2 video storage
        └── runs/          # In-memory run records
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

`src/shared/` holds one wire contract per panel plus `tasks.ts`, `runs.ts`, and `sse.ts`. Everything
there is types and constants only: no bindings, no secrets, no model contracts. Model descriptors
stay in the Worker's domain tier and reach the browser only through `/api/catalogue` — which is how
the browser learns each model's control capabilities without being able to decide them.

The one thing in `src/shared/` that is neither a type nor a wire field is `VIDEO_RETENTION_HOURS`,
and it is there for the same reason: two panels display it and the scheduled reaper enforces it, so
it has to be one number rather than three that agree today.

`access-policies.ts` sits at the top rather than in `shared/` because its consumers are not the two
runtime tiers — it is imported by the Worker's Access middleware and by the Vite plugin that
emulates Access in development, which is what keeps the local and deployed authorization paths
identical rather than merely similar.

## API

| Route                                   | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/me`                           | The server's verified view of who you are.                                    |
| `GET /api/catalogue`                    | Panels, reviewed models, and the gateway exception register.                  |
| `POST /api/chat/stream`                 | Chat as server-sent events: `start`, `delta`, then `completed` or `problem`.  |
| `POST /api/create-image`                | Generates one image and returns it with its run receipt and applied controls. |
| `POST /api/describe-image`              | Describe a picture with a reviewed vision model.                              |
| `POST /api/remix-image`                 | Edit a picture with a reviewed reference-image model.                         |
| `POST /api/classify-image`              | Rank a picture against a reviewed classifier's fixed label set.               |
| `POST /api/generate-music`              | Compose one track and return it with its receipt and non-token cost estimate. |
| `POST /api/animate-image`               | Accepts a picture and starts an animation job; answers `202` with a run id.   |
| `GET /api/animate-image/:runId/status`  | Job state, and the stored video and receipt once it completes.                |
| `GET /api/animate-image/:runId/video`   | The finished animation, supporting ranged reads so it can seek.               |
| `POST /api/animate-image/:runId/cancel` | Terminates the job and deletes anything it had stored.                        |
| `GET /api/runs/:runId/metrics`          | Resolved or pending gateway cost for one of your own runs.                    |

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

Classify Image shares that body-limit derivation and that plain-JSON shape, and adds one refusal of
its own: a body carrying `instruction`, `prompt`, or `question` is rejected with a message saying a
classifier scores a picture against a fixed label set and has nothing to be asked. Ignoring the
field would let a caller who misunderstood the panel keep believing it was honoured.

A request body may not carry `user`, `email`, `actor`, `sub`, or `system`. Such a body is
**rejected** rather than having the field stripped, because stripping is a silent correction that
makes an attempt look like success and leaves nothing for a test to assert on. Describe Image and
Classify Image extend the same rule to fields that would describe their picture — `mediaType`,
`width`, `fileName` — since the server determines those from the bytes.

## Implementation status

**Complete.** All eighteen phases of
[`specs/playground/02-implementation.md`](../../specs/playground/02-implementation.md) are
delivered, and every panel in the catalogue is built — there is no "coming in a later phase"
placeholder left in the application.

- **Phase 1** delivered the shell, the Terraform lifecycle, Access, the mandatory-gateway
  foundation, the shared contracts, and the test harness.
- **Phase 2** delivered View Tokens, the first usable panel.
- **Phase 3** delivered Chat: the first gateway-routed inference, streaming output, the run receipt
  and metrics lifecycle, and the first real figure in the session cost meter.
- **Phase 4** delivered Create Image: per-model control capabilities, byte-level media validation, a
  comparison gallery, and the first binary output.
- **Phase 5** delivered Describe Image: the first _uploaded_ media, header-level dimension limits,
  and per-model required/optional contracts.
- **Phase 6** delivered Remix Image: byte-verified reference-image editing with Cloudflare-hosted
  FLUX.2 Klein 4B by default, FLUX.2 Klein 9B and Dev, plus P-Image-Edit and Nano Banana 2 for
  cross-provider comparison, preservation-aware example instructions, safe immediate retrieval of
  provider-hosted result, a keyboard-operable before/after comparison, and the transient Create
  Image handoff.
- **Phase 7** delivered Classify Image: the first non-generative model, a ranked structured result
  rendered as an accessible table rather than a wall of bars, result controls applied to the
  response because the reviewed classifier's schema accepts none, and explicit copy about what a
  confidence score is and is not.
- **Phase 8** delivered Create Video, and with it the demo's first storage product and first durable
  job. See [Create Video: storage and durable jobs](#create-video-storage-and-durable-jobs) for why
  both were necessary and why no job table came with them.
- **Phase 9** delivered Read Text, the first panel whose models share _no_ controls at all. See
  [Read Text: models that agree on nothing](#read-text-models-that-agree-on-nothing) for what that
  forced, and why the audio is not stored.

- **Phase 10** delivered Transcribe Audio, whose models disagree about the _payload itself_. See
  [Transcribe Audio: three encodings, three envelopes](#transcribe-audio-three-encodings-three-envelopes)
  for why the file size limit changes with the model, and why two "confidence" numbers here are not
  comparable.

- **Phase 11** delivered Translate Text, whose models disagree about _how many times one click is
  billed_. See [Translate Text: one click, many charges](#translate-text-one-click-many-charges) for
  why the limit is on lines rather than length, and why the swap action exists for one model and
  cannot exist for the other.

- **Phase 12** delivered Classify Text, whose models disagree about whether there is a _score at
  all_. See [Classify Text: a closed set of answers](#classify-text-a-closed-set-of-answers) for why
  the result is a discriminated union, and why one refusal in this panel is a security decision
  rather than a validation one.

- **Phase 13** delivered Semantic Search, whose reviewed models disagree about whether they produce
  a reusable vector or a query/passage relevance score. See
  [Semantic Search: retrieval before generation](#semantic-search-retrieval-before-generation) for
  why similarity is never presented as a probability, why scores cannot be compared between models,
  and why a repeat embedding search can make no model calls at all.

- **Phase 14** delivered Evaluate Choices, the typed-decision panel and the exact inverse of
  Classify Text. See
  [Evaluate Choices: a typed contract, not a prompt](#evaluate-choices-a-typed-contract-not-a-prompt)
  for why the caller supplies the questions here but cannot supply a prompt, why confidence is
  rendered separately from every probability, and why one of the three question types has no
  confidence at all.

- **Phase 15** delivered Generate Music, the **first credit-dependent panel** and the one the
  session cost meter was built for: its two models bill in two different units, and neither is a
  token. See
  [Generate Music: when the unit is not a token](#generate-music-when-the-unit-is-not-a-token) for
  why one model has a track-length control and the other genuinely cannot, and why this panel needs
  no Workflow despite producing media.

- **Phase 16** delivered Animate Image, which shares every piece of Create Video's infrastructure
  and none of its route. See
  [Animate Image: sharing an implementation, not a tab](#animate-image-sharing-an-implementation-not-a-tab)
  for why the source picture has four different names across four models, why one model's prices
  cannot be reduced to a rate, and why this panel's image size limit is lower than every other image
  panel's for a reason that has nothing to do with images.

Phase 17 delivered Detect Objects with a Cloudflare-hosted, credit-free model. It is not a scored
classifier: Moondream localises the visitor's phrase and returns structured normalised boxes. The
phrase becomes each table row's honest label; the model supplies neither a label nor a confidence.

**Phase 18** was the capstone: an accessibility and security review across every panel, a
cross-panel observability audit, the scheduled R2 reaper that phase 8 deferred, a descriptor
reconciliation against the live catalogue, and the resolution of the derived-instance-ID question
phase 8 left open. It added one panel-level behaviour — generated video now expires — and otherwise
hardened what was already there.

The phase order was driven by **whether Cloudflare hosts a model for the task**, which was a
practical constraint rather than a preference: a third-party model bills against prepaid AI Gateway
credits, so a panel with only third-party options cannot be built or demonstrated on an unfunded
account. Phases 9–14 — Read Text, Transcribe Audio, Translate Text, Classify Text, Semantic Search,
and Evaluate Choices — all had Cloudflare-hosted models and needed no credits. Generate Music (15)
and Animate Image (16) had no hosted option, so they came after. Each phase recorded its candidate
hosted and third-party models and re-confirmed the hosting before it started, because the catalogue
changes — and it did: phase 17 found a hosted detector that had not existed when the sequence was
written, which is why a credit-free panel ends up after two paid ones.

Generate Music re-confirmed it at delivery, and the answer had not changed: `cf ai models list`
returns 69 Cloudflare-hosted models across ten task types, and **Music Generation is not one of
them**. A search for "music" matches nothing. So phase 15 is where the ordering constraint ran out
and the first credit-dependent panel shipped — which is also why it is the panel whose honesty
obligations about cost are the heaviest in the application.

Animate Image moved from phase 9 to phase 16 for exactly that reason: it shares all of Create
Video's infrastructure and would otherwise be the obvious next step, but every image-to-video model
is third-party. It re-confirmed that at delivery and the answer had not changed — there is no
**Image-to-Video task type in the Workers AI catalogue at all**, so there was nothing to move it
back for.

### Detect Objects: phrase localisation, not scored classification

Detect Objects uses Cloudflare-hosted `@cf/moondream/moondream3.1-9B-A2B` in its dedicated
`task: "detect"` mode. It sends the byte-validated upload as a full `data:` URI, never an arbitrary
URL. The model returns structured normalised boxes for a natural-language target and `max_objects`
is a genuine provider-side limit. The overlay uses percentage coordinates and scales with the image;
the accessible table remains a complete result if overlays are unavailable.

This is intentionally not Classify Image with boxes. Moondream returns neither labels nor scores, so
every region is honestly labelled with the visitor's target phrase, has a textual position such as
“upper left”, and has no confidence bar or score floor. LLaVA and Llama Vision were excluded because
they would require parsing prose into boxes; Llama Vision additionally requires a licence agreement.

## Create Video: storage and durable jobs

Every panel up to this point held its media in the browser and stored nothing. Create Video breaks
that, and the reasons are worth reading before copying any of it, because three of them are not what
you would guess from the outside.

**The model returns a URL, not bytes.** Every text-to-video model in the catalogue answers with
`{ state: "Completed", result: { video: "https://…" } }` — a short-lived link on the provider's own
host. So the panel never receives media from the model at all. Rendering that link directly would
make the result depend on an external host's retention, leak the visitor's IP to it, and break for a
run reopened from history minutes later.

**There is no provider job to poll.** The envelope carries a `state`, but `Completed` is the only
documented value and the call resolves when generation has finished. There is no provider-issued job
identifier. The job this panel reports on is therefore **its own Workflow**, not the provider's — if
you are looking for the polling adapter that talks to a provider's job API, there isn't one, because
there is no such API to talk to.

**R2 is here for seeking, not for size.** A `<video>` element issues `Range` requests to show a
poster frame, seek, and play without downloading the whole file. The base64-in-JSON transport every
other panel uses cannot answer a `Range` request, so reusing it would produce a player that cannot
seek. R2 answers ranged reads natively, and `R2Bucket.put()` accepts a `ReadableStream`, so provider
bytes are piped into storage without ever being buffered whole in a 128 MB isolate. The memory
argument is real but secondary; seeking is what made storage non-negotiable.

**Workflows is here because the visitor's connection is the fragile part.** An HTTP-triggered Worker
has _no_ wall-clock duration limit while the client stays connected, so a multi-minute render would
fit inside a request. But when the tab closes, the request is cancelled and `waitUntil()` extends
execution by only about thirty seconds — and a render abandoned halfway has still been _paid for_. A
panel whose subject is honest cost cannot casually discard dollars, so generation is durable.

### Why there is no job table

A Workflow instance already _is_ a job record: it reports `queued`/`running`/`complete`/`errored`,
carries its output, and retains terminal state for days. Adding D1 or KV beside it would create
**two sources of truth for one job status**, and the predictable result is a job that one store
calls finished while the other calls it running. So this panel adds neither.

That leaves ownership, which a stored owner column would normally provide. Instead the identifier
_is_ the proof: it is an HMAC of the verified email and the browser's run identifier, keyed by the
Access audience tag. The status route recomputes it from the identity on the current request, so a
visitor asking after someone else's run derives a different identifier, finds nothing, and receives
a `404` — not a "forbidden", which would itself confirm the job exists. Ownership becomes
unforgeable because it is not stored anywhere to be tampered with. See
`src/worker/domain/media-job-identity.ts`.

#### The derived identifier is in the logs, and that was a decision

Every Workflow log line carries `$workers.instanceId` automatically, and that value _is_ the HMAC.
No application code can suppress it. Phase 8 found this in deployed logs and left the choice open;
phase 18 resolved it in favour of **keeping the derivation**, for a reason worth stating precisely
rather than overstating in either direction.

The digest is **per run, not per visitor**. It is keyed over the email _and_ the run identifier
together, so two runs by the same person produce entirely unrelated values — they cannot be grouped,
counted, or linked to each other. What is in the log is functionally an opaque per-run token that
happens to be derived rather than randomly generated, and it is not reversible to an email because
the key is one a visitor cannot read.

The alternative — a random instance ID with the ownership mapping stored — would mean adding a KV
namespace or D1 table purely to hold that mapping, which re-introduces the second source of truth
for job state that the section above exists to avoid. That is a real regression traded for a
marginal gain. The residual exposure is that someone who can already read Worker logs _and_ holds
the Access audience tag could confirm a guessed email; that same person can read the account's AI
Gateway metadata, where the email is recorded deliberately.

What did change is the claim. This README previously implied Worker logs contain nothing
identifying. The accurate statement is narrower: **this application logs no identifying field.** The
platform's own metadata is not this application's to control, and a per-run derived identifier does
appear in it.

### A failure a Workflow boundary silently erased

Within a request, a failed inference call becomes a `ProblemDetailsError` and the Hono handler
renders its status and message. A Workflow step cannot do that: a thrown error is recorded on the
instance as `{ name, message }`, so the `problemDetails` payload is **dropped on the way out**.

The first symptom was the worst possible one. An account with no prepaid AI Gateway credit produced
`An unexpected error occurred` — the single failure a visitor can actually resolve, reported as the
one thing they cannot act on. The inference client's credit detection was working correctly the
whole time; the classification was being thrown away one layer later.

So the cause is now classified _inside_ the step, before it crosses the boundary, and re-thrown
carrying a fixed marker token (`src/worker/domain/provider-failures.ts`). The marker is one of a
closed set of slugs, so using the error message as the channel leaks nothing a provider wrote — the
same guarantee the request path makes by sanitising. The panel then renders the billing case as its
own notice naming prepaid credit, and says plainly that retrying will not help, because without
credit every retry fails identically.

Any later phase that puts an inference call inside a Workflow inherits this constraint.

Two further things were learned by reading the deployed logs, and both are worth copying.

**The toolkit's error handler logs nothing.** `problemDetailsErrorHandler` converts any error that
is not a `ProblemDetailsError` into a `500` carrying "An unexpected error occurred" — and discards
the error. That makes the one class of failure nobody anticipated the one class that leaves no
record, which is the worst possible trade. It is filed upstream as
[adrianhall/cloudflare-toolkit#209](https://github.com/adrianhall/cloudflare-toolkit/issues/209), so
the composition root wraps it as a workaround and logs the name, message, stack, and wrapped cause
first (`unhandled_request_error`). An expected `ProblemDetailsError` is deliberately _not_ logged
there: those are already described by their status, and logging them would bury the unexpected ones.

**The platform logs the derived instance ID.** Every Workflow log line carries
`$workers.instanceId`, and for this panel that value _is_ the keyed HMAC of the verified email. This
application's own log fields contain no email, prompt, or object key — that is asserted by tests —
but the platform's metadata is not something application code can suppress. The digest is keyed by a
secret a visitor cannot read, so it is not reversible to an email, and anyone who can read these
logs can already read the account's AI Gateway metadata where the email is recorded on purpose. It
is still a stable per-visitor identifier in the Worker log, so the claim this demo makes is the
narrower and accurate one: **this application logs no identifying field**, rather than the log as a
whole containing none. Whether to keep the derivation or move to an opaque instance ID with a stored
ownership mapping is left as an explicit decision for the hardening phase.

### Two cost traps this panel had to avoid

**Workflow steps retry by default.** That is normally their whole value, but the inference step here
bills per second of generated video and can cost several dollars, so an inherited default would turn
one transient provider fault into several charges — and nothing about the panel's behaviour would
look wrong while it happened. The inference step runs with `retries: { limit: 0 }`; only the cheap,
idempotent fetch-and-store step keeps them. Both policies live in `src/worker/domain/media-job.ts`
with a test asserting the zero, because no functional test would ever reveal the problem.

**Pricing spans thirtyfold by resolution.** `$0.025` a second at 360p against `$0.28` at 1080p, so a
fifteen-second render can be a few cents or several dollars. Every descriptor therefore defaults to
the _cheapest_ resolution rather than the model's own default, the per-second price is shown against
each option in the selector, and an estimate appears next to the button that spends it. The estimate
is labelled an estimate everywhere; the authoritative figure is still the AI Gateway log's.

### What is stored, and what is not

Only generated video, only under the `generated-video/` prefix, and only through `R2VideoStorage` —
which refuses any key outside that prefix, so the containment is a property of the code rather than
a convention. An architecture test asserts that no other module writes to a bucket.

**Uploaded images are deliberately still transient.** Routing them through R2 was considered and
rejected: the vision and classification models take the image _in the request_, so the Worker would
have to read every byte back out of storage to make the call — the bottleneck moves rather than
disappearing — and it would add a retention surface this demo otherwise does not have to explain.
The 1 MB image cap comes from base64-in-JSON, not from missing storage.

**A finished video is deleted 24 hours after it is stored.** An hourly cron trigger runs a
`scheduled()` handler that lists the `generated-video/` prefix and collects anything past the
window. `pnpm teardown` still empties the bucket before Terraform destroys it, because R2 refuses to
delete a bucket that still holds objects — the reaper keeps a _running_ demo clean, teardown keeps
the account clean.

Four details make it correct rather than merely present, and each is a test:

- **It is driven by the bucket, not by what the application remembers.** Each object's own
  `uploaded` timestamp is the authority — never anything encoded in a key. The objects most in need
  of collecting are exactly the ones nothing remembers: a Workflow instance whose state has aged
  out, or a run abandoned before it recorded anything. A reaper that deleted only objects it could
  still find a job for would leave precisely the orphans behind while appearing to work.
- **The work per invocation is bounded**, at 500 objects, below R2's 1000-key ceiling for a single
  `list()` and a single `delete()`. A cron invocation has a fifteen-minute wall clock, and a reaper
  that tried to drain an arbitrary backlog in one firing would fail exactly when there is most to
  do. Falling behind is recoverable; a handler that always times out is not. The run reports whether
  it hit the budget, which is the only signal that the schedule is too slow — without it the reaper
  fails silently by never catching up.
- **It is confined to the prefix.** The storage adapter refuses any key outside `generated-video/`,
  so a future user of this bucket cannot have its objects collected by a job that predates it. That
  pairs with the write guard: one test proves nothing else is written there, another proves nothing
  else is deleted.
- **It logs a summary and never a key.** An object key is derived from a verified identity and a run
  identifier, so keys are identifying and fall under the same rule as the email.

**The retention window is written down once.** `VIDEO_RETENTION_HOURS` in
`src/shared/create-video.ts` is the only place the figure exists; the reaper derives its own
milliseconds from it, both panels display it, and a test asserts the panels quote the constant
rather than the number. Phase 8 deliberately refused to let the UI claim any expiry, because nothing
enforced one and a countdown this demo could not honour would have been worse than silence. That
constraint is lifted in one direction only: the UI may state the figure _because_ the reaper
enforces it.

There is deliberately **no R2 bucket lifecycle rule**. It would be a second owner of object
lifetime, expiring objects on a schedule no test could check against the constant.

## Animate Image: sharing an implementation, not a tab

Animate Image takes a picture you supply and makes a short video out of it. It is the other half of
the demo's most memorable sequence: generate a picture in **Create Image**, then click **Animate
this image** and watch it move.

It is also the clearest example in the application of a decision that is easy to get wrong. Animate
Image and Create Video share a job lifecycle, an R2 bucket, a storage adapter, an ownership scheme,
a video player, and a credit-failure path. The tempting conclusion is that they are one panel with a
mode switch. **They are not.** Someone arriving with a photograph should find a destination called
"Animate Image", not discover their task hiding inside a tab called "Create Video". So the two share
the _implementation_ and nothing in the route table: separate panel, separate URL, separate
endpoints, separate title — and underneath, deliberately, no second bucket, no second job mechanism,
and no second definition of what "running" means.

An architecture test enforces the sharing half of that, asserting that both services are built over
the same bucket binding and the same job-identity derivation. The router tests enforce the other
half, asserting that neither panel nests the other and that no mode selector exists.

### The source image has four different names

Four reviewed models, one concept, four spellings — captured live from each provider's validator
rather than transcribed from documentation:

| Model                     | Image parameter     | Accepts a `data:` URI? |
| ------------------------- | ------------------- | ---------------------- |
| `alibaba/hh1.1-i2v`       | `image`             | **yes**                |
| `minimax/hailuo-2.3`      | `first_frame_image` | **yes**                |
| `runwayml/gen-4.5`        | `image_input`       | **yes**                |
| `lightricks/ltx-2-5-fast` | `image_uri`         | **no — HTTPS only**    |

That disagreement is exactly why this demo drives every panel from reviewed per-model descriptors
instead of a hardcoded request shape. The visitor supplies "a picture"; the wire name is read from
the descriptor at the last moment, the same way Create Video resolves `quality` against
`resolution`.

The last row decided which models could be offered at all. **Every one of these models types its
image parameter as a URI rather than as bytes** — `alibaba/hh1.1-i2v` rejects a non-URL value with
`Invalid value at image: Invalid URL`. Three of the four accept an inline `data:` URI, which is what
lets the picture travel inside the request and never be published anywhere.
`lightricks/ltx-2-5-fast` refuses one with `Must be an HTTPS URL`, so offering it would mean
uploading a visitor's picture to a publicly fetchable address purely to satisfy a parameter type. It
is **not registered**, and the descriptor carries an explicit `imageDelivery` field so that refusal
is a recorded capability rather than an unexplained omission.

`pruna/p-video-animate` was probed and skipped for a different reason: it requires both `video` and
`image`, making it a motion-transfer model rather than an image-to-video one.

### Two models that agree on almost nothing

|                | HappyHorse 1.1 I2V (default)    | MiniMax Hailuo 2.3                    |
| -------------- | ------------------------------- | ------------------------------------- |
| Image field    | `image`                         | `first_frame_image`                   |
| Motion prompt  | **optional**                    | **required**                          |
| Resolutions    | `720P`, `1080P`                 | `768P`, `1080P` — **no shared value** |
| Durations      | any integer **3–15 s**          | **exactly 6 or 10 s**                 |
| Billed         | **$0.14/s** @720P, $0.18 @1080P | **per exact combination** (see below) |
| Negative promp | yes                             | no                                    |
| Seed           | yes                             | no                                    |

Because the two share no resolution value and disagree about which durations exist, **switching
model resets the controls** rather than carrying a selection across — a `720P` sent to MiniMax is a
rejected request, not a near miss.

HappyHorse is the default because it is the direct counterpart to Create Video's
`alibaba/hh1.1-t2v`: same vendor, same control vocabulary, so reading the two panels side by side
makes the shared descriptor shape obvious.

### A price that is not a rate

Create Video could always quote a cost as "rate × seconds". One model here cannot be described that
way at all. MiniMax publishes **$0.28 for six seconds** at 768P and **$0.56 for ten** — 4.67¢ and
5.6¢ a second respectively. There is no single per-second figure to show.

So the descriptor carries two mutually exclusive pricing shapes, and the panel renders two genuinely
different cost sentences depending on which one the selected model declares. A test asserts that no
model declares both, since that would leave estimation with two answers for one run.

The more interesting case is the third one. The catalogue publishes no price for MiniMax at **ten
seconds at 1080P**, so this demo **does not interpolate one**. Guessing from the two figures it does
publish would be inventing a number and attributing it to the provider — in the one panel whose
subject is honest cost. The panel instead says _"No published price for 10 seconds at 1080P. This
run will still be charged; the amount simply is not knowable in advance."_ That distinction is
carried all the way through the stack as a boolean beside the figure, because `$0.00` and "nobody
has said" are opposite claims and only one of them is true.

### A picture limit that is really a Workflow limit

Every other image panel in this demo accepts **1 MB**. Animate Image accepts **640 KB**, and the
reason has nothing to do with images.

The picture does not stop at the request: it is carried into a Workflow instance as an event
parameter, and **a Workflow event payload is capped at 1 MiB**. Base64 expands bytes by four thirds,
so a 1 MB picture becomes a 1.37 MiB parameter and the job fails at creation — _after_ the panel had
told the visitor their picture was fine. 640 KB encodes to roughly 874 KB and leaves room for the
prompt, the controls, and the identity in the same payload. The limit is this demo's rather than any
provider's, and the panel says so when it refuses a picture.

### What is sent, kept, and claimed

The source picture goes into the request and into instance state, and this demo writes it to **no
storage product** — Create Video's Finding 10 holds unchanged, and the R2 bucket remains for
generated video only. But the picture does reach a third-party provider, so the panel tells a
visitor to **assume it is logged exactly as a prompt is** rather than offering a retention guarantee
that is not this demo's to give. A global test forbids any panel from claiming otherwise.

The generated video is handled the opposite way and for Create Video's reasons: the model returns a
short-lived provider URL, so the bytes are fetched server-side under a host allowlist, sniffed, and
written to the shared bucket under the same `generated-video/` prefix — which is what lets the
player seek, and what means one scheduled reaper will eventually collect both panels' output.

### Credits are required, and nothing here has been verified against a successful run

**There is no Cloudflare-hosted image-to-video model**, and no Image-to-Video task type exists in
the Workers AI catalogue. Every model in this panel is third-party and bills against prepaid AI
Gateway credits. On an account without them, a valid request returns Gateway error **`2021` / HTTP
`402`** — "Insufficient balance; add money to your gateway or use BYOK" — which this demo already
classifies as `insufficient-credit` and presents as its own notice saying _add credit_ rather than
_try again_, because retrying cannot help.

The account this was built on has no credits, so **no animation has ever been generated**. Every
statement above about what a provider _accepts and rejects_ was captured live from its validator,
which runs before billing. Nothing about the output envelope, the real CDN hosts, or the
authoritative gateway cost has been observed. See the phase-16 contract review in
[`specs/playground/02-implementation.md`](../../specs/playground/02-implementation.md) for the
explicit list.

## Generate Music: when the unit is not a token

Every panel before this one put a figure in the session cost meter. This one puts a figure in it
that **is not a token count and cannot be compared to one** — and then does it twice, in two
different units, from the same selector.

|                | ElevenLabs Music v2                 | MiniMax Music 2.6                     |
| -------------- | ----------------------------------- | ------------------------------------- |
| Billed         | **$0.0025 per second of audio**     | **$0.15 per track**, any length       |
| Lyrics charge  | —                                   | **+$0.01** when the model writes them |
| Track length   | `music_length_ms`, 3–600 s          | **no length field at all**            |
| Instrumental   | `force_instrumental` (optional)     | `is_instrumental` (**required**)      |
| Lyrics         | **no lyrics field**                 | `lyrics`, or written from the prompt  |
| Output formats | `mp3_44100_128`, `mp3_48000_320`, … | `mp3`, `wav`                          |
| Seed           | yes, 0–4,294,967,295                | no                                    |

There is no Cloudflare-hosted alternative: the Workers AI catalogue has no music model at all, and
no Music Generation task type. Both options are third-party and bill against prepaid AI Gateway
credits, which is why this panel is the last in the sequence and the first that an unfunded account
cannot run.

### The billing units are the lesson

Generate a short track on each model, run a Chat prompt beside them, and the meter shows a per-token
charge, a per-second charge, and a per-track charge side by side. The demo never turns one into
another. Three specific consequences follow:

- **The estimate is quoted before the request, with its unit named.** `$0.15` means something
  different for a per-track model than for a per-second one, so the figure never appears without the
  sentence explaining how it was reached. The authoritative number still comes from the AI Gateway
  log afterwards, and the estimate is labelled an estimate everywhere.
- **The estimate moves with the length control for one model and not for the other.** That is the
  clearest demonstration available that "what did it cost" has more than one shape: on ElevenLabs
  the length slider _is_ the price control; on MiniMax it does not exist and the price is flat.
- **No charge here is ever derived from tokens.** Neither model reports a token count, so there is
  nothing to derive one from, and a figure assembled anyway would be the exact misreading this panel
  exists to correct. The session ledger adds the costs AI Gateway reported — the one thing a
  per-token, per-second, and per-track run genuinely have in common.

At sixty seconds the two prices meet exactly: a minute of ElevenLabs audio costs $0.15, which is
MiniMax's flat charge for a track of any length. Either side of that line a different model is the
cheaper one, and that is a real decision rather than a trivia point.

### A length control that cannot exist

MiniMax has no `duration`, no `length`, and no equivalent. Its schema sets
`additionalProperties: false`, so sending one is a **rejected** request rather than an ignored field
— the model decides how long the track is and charges the same either way. The panel therefore
renders no length control for it and says why, because a missing control with no explanation reads
as a page that failed to load.

The same is true in the other direction for lyrics. ElevenLabs has no lyrics field; vocals are
described in the prompt. A request carrying `lyrics` is refused with a message naming the model
rather than having the field dropped, since dropping teaches a visitor that the control did nothing
when the truth is that this model does not have one.

### One provider rule, enforced before the charge

MiniMax refuses a vocal track with neither supplied nor generated lyrics — "When `is_instrumental`
is false and `lyrics_optimizer` is false, `lyrics` must be provided". That rule is reimplemented in
the domain layer, and on a per-track model the reason is concrete: enforced locally it is a free
`400` naming the three ways out of it, while left to the provider it would be an opaque error after
fifteen cents had been spent. The browser mirrors the same rule from the published descriptor, so
the button explains itself before it is pressed.

Two more combinations are refused rather than resolved by precedence: lyrics on an instrumental
track, and supplying lyrics while also asking the model to write them. The second matters because
writing lyrics is a **separate charge** — silently preferring one input would be silently paying for
the other.

### The track is fetched, checked, and not stored

Both models answer with a short-lived URL on their own CDN rather than with audio. Rendering that
URL in the page would be simpler and worse in three ways: it leaks the visitor's IP address and
referrer to a third party on every play, it makes the result depend on an external host's retention,
and it lets the provider's `Content-Type` header decide how the browser treats the response. So the
Worker fetches it once, **server-side, from an exact host allowlist published in the descriptor**,
refuses a redirect, bounds the read, and establishes the media type by **sniffing the bytes**. A
provider answering with an HTML error page under a `200` fails there rather than reaching a player.

Unlike Create Video, nothing is stored. A track is a few megabytes, an `<audio>` element seeks
freely within a payload the page already holds, and there is no `Range` request to answer — so
storage would add a retention surface this demo would then have to promise something about. The
panel states plainly that the audio lives in the page only, and that the provider's own copy may
already have expired.

### The player, and the waveform that is not there

Native `<audio controls>` provides play, pause, seeking, volume, keyboard operation, screen-reader
announcement, and the system media keys. On top of it the panel adds restart, back-ten, and
forward-ten buttons plus <kbd>←</kbd>, <kbd>→</kbd>, <kbd>Home</kbd>, and <kbd>k</kbd> shortcuts,
because a two-minute track is long enough that seeking matters. The shortcuts deliberately **ignore
events originating on the audio element itself**, so the browser's own arrow-key seeking keeps
working rather than being overridden by a worse version of itself. <kbd>Space</kbd> is left unbound:
it is how a keyboard user activates the focused button.

There is **no waveform**. Drawing a real one means decoding the audio and reducing a couple of
million samples per track in the main thread, or adding a visualisation package; a decorative shape
that did not correspond to the audio would be a picture of a different track. The length, format,
and size are reported as text instead.

The lyrics panel is always present, because its content and its absence are equally informative.
Supplied lyrics are shown as a peer of the player rather than behind a disclosure — audio is the one
output some visitors cannot perceive at all. An instrumental track says so. And a track whose lyrics
the model wrote says that the model charged separately for them and **returned only the audio**, so
the words exist in the recording and nowhere else.

### Why there is no job here

Create Video needs a Workflow because a render takes minutes and a cancelled request is a render
that was paid for and discarded. Neither music model has a job API: no job handle, no polling
endpoint, no operation identifier, and both document the result arriving from the call itself. A
Workflow would therefore add a polling protocol, a storage product, and a derived-key scheme to
deliver a value the request already has. Generation is still noticeably slower than a text
completion, which the panel handles with an honest progress state and a cancellable request — and it
says plainly that stopping the wait does not stop the charge, because by then the model is already
working.

## Read Text: models that agree on nothing

Every earlier panel's models disagreed about _degree_ — a different step ceiling, a wider token
range, an extra parameter. Read Text's three reviewed models disagree about _kind_, and that is the
reason this panel is worth reading.

|               | Aura 2 / Aura 1           | MeloTTS                  |
| ------------- | ------------------------- | ------------------------ |
| Text field    | `text`                    | `prompt`                 |
| Voice         | 40 / 12 named speakers    | **no speaker parameter** |
| Language      | **no language parameter** | `lang`                   |
| Output format | `mp3` or `wav`            | always MP3               |
| Billing       | per 1,000 characters      | per minute of audio      |

There is no intersection. A single hardcoded form could not drive both families, and every one of
these differences is load-bearing:

- **The text field has two names.** Sending MeloTTS a `text` field is a request missing its only
  required property. The wire name lives in the reviewed descriptor, so the browser sends neutral
  `text` and the server renames it.
- **Voice and language are mutually exclusive.** The panel renders a voice selector _or_ a language
  selector, never both and never a disabled one — a control the provider would reject has no honest
  disabled state. It also _says_ which family the selected model belongs to, so an absent voice
  selector reads as a fact about the model rather than a gap in the page.
- **The two Aura generations overlap only partially.** They share eight voice names and differ on
  eight more, so switching model resets a voice unless the new model also publishes it. Carrying it
  over blindly would stage a request the server refuses.
- **One output format is two provider fields.** Aura spells a choice as `encoding` plus `container`,
  and the legal pairings are in its prose rather than its schema. This demo exposes one name and
  expands it, so a visitor cannot assemble a pair the provider accepts and the browser cannot play.

**Rate and pitch do not exist.** The phase brief asked for them "when supported"; the reviewed
answer is that none of the three models support either. They stay in the wire contract and are
_rejected_ rather than dropped, and the panel states the absence — because silently ignoring a
control teaches that the control did nothing, when the truth is that the model does not have one.

### The cost estimate is sometimes impossible

This is the first panel that can quote a price _before_ a synchronous request: the Aura models bill
per thousand characters, and the visitor has already typed them. It is also the first where that
cannot be done at all. MeloTTS bills per minute of audio that does not exist until after the call,
so the estimate is reported as **absent** rather than as zero. A zero would read as "free", which is
the one thing a cost figure must never do.

### The audio is not stored, and that is the opposite of Create Video

Create Video needed R2 because the provider returns a short-lived URL rather than bytes, and because
`<video>` seeks with `Range` requests a JSON body cannot answer. Neither applies here: these models
return the bytes themselves, the payload is a few hundred kilobytes, and an `<audio>` element seeks
freely within a `data:` URI the page already holds. Storing it would add a retention surface for no
benefit, so the architecture test that confines writes to the video path covers this panel too.

The media type still comes from **sniffing the returned bytes**, never from a provider header — the
same rule as the image panels, and for the same reason: the type decides how the browser treats the
payload. It matters more here than it looks. Aura's schema permits `linear16` with no container,
which is real audio data that no browser will play; that output is refused with a `502` rather than
reaching the page labelled as playable.

### The text alternative is the result, not a caption

Audio is the one output in this demo that some visitors cannot perceive at all. The spoken text is
therefore rendered beside the player as a peer of it — not behind a disclosure — so the result is
available in both forms at once. It costs nothing to show, since the text _is_ what the model was
given, and it removes any doubt about what was actually read.

## Transcribe Audio: three encodings, three envelopes

Read Text's models disagreed about _controls_. Transcribe Audio's disagree about the **payload** —
they want the same bytes in three different shapes, and return the answer in three unrelated ones.

|                | Whisper large v3 turbo | Nova 3                                           | Whisper (original)       |
| -------------- | ---------------------- | ------------------------------------------------ | ------------------------ |
| Audio in       | base64 string          | `{ body, contentType }`                          | `number[]`, one per byte |
| Max file       | 4 MB                   | 4 MB                                             | **1 MB**                 |
| Transcript out | `text` + `segments[]`  | `results.channels[0].alternatives[0].transcript` | `text` + `words[]`       |
| Language       | ISO 639-1              | **BCP-47**                                       | no parameter at all      |
| Quality figure | `avg_logprob`          | `confidence` (0–1)                               | none                     |
| Price          | $0.0005/min            | $0.0052/min                                      | $0.0005/min              |

Four of those rows change what the panel does:

- **The file size limit is per model.** This is the first panel where that is true. A 4 MB file
  becomes four million JSON numbers for the byte-array model, and the measurements recorded for
  Describe Image's 1 MB image cap show that exhausting a 128 MB isolate with one ordinary request is
  arithmetic rather than theory. So the same file is accepted for one model and refused for another,
  the picker reads its ceiling from the catalogue, and the refusal **explains why** — without that,
  a file that worked a moment ago being rejected reads as a bug.
- **A language code is a per-model contract.** `en-GB` is valid for exactly one reviewed model.
  Merging the lists into one would invent a standard none of the providers agreed to, so the panel
  offers each model's own codes and says they differ.
- **"Confidence" means two different things.** Nova 3 returns a probability in `[0, 1]`; Whisper
  returns an average log probability, which is negative and unbounded below. Normalising the second
  into the first's range — the obvious way to make one progress bar work for both — would fabricate
  a meaning the model never gave it. The probability gets a bar, the log probability gets its raw
  number and a plain-language warning, and the model that reports neither gets no column at all.
- **The envelope is read from the reviewed descriptor, never guessed.** Probing for keys would be
  more forgiving and considerably worse: a changed contract would find some other string field and
  present it as a transcript. Reading the declared shape turns that same break into a logged `502`.

### The microphone is optional, and stays optional

The panel is complete by file upload alone. The record button is **absent** — not disabled — on a
browser without `MediaRecorder` or a secure context, because a disabled control implies the feature
exists and is temporarily unavailable. Permission states are modelled explicitly rather than as
booleans, since a denial and a device fault need opposite advice: one is a decision the visitor can
revisit in their browser settings, the other is something retrying might genuinely fix.

Browsers do not agree on a recording format either — Chrome and Firefox produce WebM, Safari
produces MP4 — so the container is negotiated with `MediaRecorder.isTypeSupported` rather than
assumed, and both signatures are in the input allowlist.

### Input and output audio share one sniffer, with different allowlists

`domain/audio-bytes.ts` now identifies audio in both directions, which is deliberate: the two share
their signature helpers, and a second copy would let one fall behind. The **allowlists** differ,
because the directions are not symmetric. Read Text decides what to render in the page, so its set
is as narrow as the browser's reliable playback support. Here the file is forwarded to a provider,
so the set must include what a browser's own recorder produces.

One detail worth copying: an MP4's `ftyp` signature sits at **offset four**, after the box size.
Matching it at offset zero is the intuitive mistake, and would reject every recording Safari makes.

### What this panel cannot tell you in advance

Every reviewed model bills per audio minute, and a compressed file's duration is not readable
without decoding it. So unlike Read Text — where the billable quantity is text the visitor has
already typed — this panel usually **cannot** quote a cost before the run, and says so rather than
leaving the figure mysteriously absent. Only WAV declares a duration cheaply enough to use, and that
is also the only format against which the ten-minute duration cap can be enforced.

## Translate Text: one click, many charges

Earlier panels' models disagreed about controls, payloads, and output shapes. Translate Text's
disagree about something a visitor feels directly: **how many times a single click is billed.**

|                   | M2M100 1.2B                      | IndicTrans2               |
| ----------------- | -------------------------------- | ------------------------- |
| Source language   | `source_lang`, 20 reviewed codes | **none** — English only   |
| Target field      | `target_lang`                    | `target_language`         |
| Code style        | ISO 639-1 (`hi`)                 | FLORES-200 (`hin_Deva`)   |
| Text in           | one `string`                     | `string \| string[]`      |
| A 12-line passage | **12 billed calls**              | **1 billed call**         |
| Output            | `{ translated_text }`            | `{ translations: [...] }` |

Four consequences, each of which changed a decision:

- **The limit is on lines, not length.** A pasted list of 200 short sentences passes any character
  cap comfortably and would be 200 charges from one click. So the panel caps _translatable lines_ at
  24, and the refusal explains that some models bill per line — otherwise the limit reads as
  arbitrary. Blank lines never count, because they are never sent.
- **The panel states the call count before the request.** Both models bill per token, which is not
  knowable until the model tokenises the text, so no currency figure would be honest in advance. The
  number of _paid calls_ is exact, and it is the figure that surprises people.
- **Line breaks are preserved by segmenting, not by hoping.** A translation model is trained on
  sentences; handing it a multi-line passage as one string gets the newlines collapsed or
  re-ordered. So each line is translated as its own unit and reassembled **by original index** —
  which is what makes a blank line in the middle of a passage survive. Consuming translations in
  order would work until exactly that case.
- **A failure partway through is a failed run, not a partial result.** A passage half-translated is
  not a translation, and returning one would look like a model that trails off while charging for
  lines nobody can use. The log records _which_ call failed and how many had already completed — the
  number someone reconciling a bill actually needs.

The calls are made **in sequence rather than in parallel**. Concurrent translation would be faster
and worse: a failure partway through a parallel fan-out leaves an unknown number of paid calls in
flight with no way to report what was spent.

### A control that cannot exist

IndicTrans2 translates from English only and its schema declares no source-language field at all. So
the source selector is replaced by plain text, and the **swap action is absent rather than
disabled** — a disabled control implies a choice that is temporarily unavailable, when the truth is
that this model has no such field. The panel says so in a sentence, because an absent control
otherwise reads as a gap in the page.

Swapping also moves the _translation_ into the source box when there is one, because checking a
translation back the other way is overwhelmingly why anyone swaps.

### Why the general-purpose LLM was not offered

`@cf/utter-project/eurollm-9b-it` was a listed candidate and is deliberately **not registered**. It
is a text-generation model, so translating with it means writing a prompt and reading prose back —
with no `target_lang` to validate and no way to be sure the reply is a translation rather than a
commentary on one. This panel's entire lesson is the _typed_ translation contract, and a general LLM
behind the same selector would teach that the language codes are decoration. Its catalogue page also
gates access behind a sign-up form, so it could not be relied on from a fresh account.

### Two standards for the same language

`hi` and `hin_Deva` name the same language, and **neither model accepts the other's spelling.** The
lists are therefore declared per model rather than merged, because merging them would invent a
standard no provider agreed to. IndicTrans2's codes name a script as well as a language, which is
why three languages appear twice in its list — Kashmiri, Manipuri, and Sindhi each in two scripts —
and why every entry carries its script in the display name.

### Accessibility notes worth copying

The translated column carries a `lang` attribute taken from the applied target language. Without it
a screen reader reads Hindi with English pronunciation rules, which is unintelligible — so this is
load-bearing rather than cosmetic. The result is a real `table` with scoped headers, and every cell
also carries a visually-hidden column label, because the rows stack on a narrow screen and a stacked
row without labels reads as alternating fragments of two languages.

The download is encoded with `encodeURIComponent` rather than base64: a naive `btoa` throws on any
character outside Latin-1, which is _every_ language one of these two models targets.

## Classify Text: a closed set of answers

This panel exists to teach the **fixed-label contract**: a classifier sorts text into categories it
was trained on, and the caller cannot invent them. So the panel publishes the complete label set
_before_ any run — a visitor can see every answer the model is capable of giving without submitting
anything, which is exactly the property a text generator does not have.

That is also the boundary with Evaluate Choices, and it is enforced rather than documented. The
request type has no field for a label, and a body carrying `labels`, `categories`, `criteria`,
`question`, or any of nine other spellings is **refused with a `400` that names Evaluate Choices**.
Refusing rather than dropping matters: someone sending `labels` has a real need and would otherwise
believe their categories were applied and that the model chose none of them.

|                         | DistilBERT SST-2     | Clef Flash                   | Llama Guard 3 8B                 |
| ----------------------- | -------------------- | ---------------------------- | -------------------------------- |
| Declared task type      | Text Classification  | **Text Generation**          | **Text Generation**              |
| Request shape           | `{ text }`           | `state` + immutable choice   | `{ messages[] }`                 |
| Answer                  | `[{ label, score }]` | choice probabilities         | `{ safe, categories[] }`         |
| Scores                  | yes                  | yes, one per reviewed choice | **none, for anything**           |
| Ranking controls        | top-k, score floor   | top-k, score floor           | **none — nothing to rank**       |
| Label set               | 2 sentiment labels   | **3 sentiment labels**       | 14 hazard categories             |
| Criteria owner          | model                | **application, immutable**   | model                            |
| Needs `response_format` | no                   | no                           | **yes — or it answers in prose** |

### The finding that shaped the panel

The three models demonstrate two routes to classification. DistilBERT is a conventional scored
classification head. Llama Guard returns a verdict — a boolean plus violated category codes — with
no number anywhere. Clef Flash is the bridge: a decision model can classify when the **application
owns one immutable choice schema**, yielding a three-way Positive / Negative / Neutral ranking.

Clef's normal API permits caller-defined questions and criteria, which belongs in Evaluate Choices.
This panel never sends browser-provided criteria: its one sentiment question is reviewed Worker
configuration, and the endpoint still refuses a body that adds labels or criteria. That keeps Clef
Flash a closed label set here instead of turning Classify Text into a generic decision API.

Llama Guard has no number to put in a confidence bar, and inventing one would be the worst possible
response, so:

- the outcome is a **discriminated union**, and the browser switches renderer on `outcome.kind`
  rather than assuming a shape. A panel that assumed a score would render `NaN%` against a perfectly
  valid answer;
- the ranking controls are **declared per model** and refused for the verdict model rather than
  accepted and ignored, because a visitor who sets a confidence floor on a model that reports no
  confidence has formed a belief that is simply wrong;
- the verdict renderer contains **no percentage anywhere**, and a test asserts that.

### The field that makes the verdict model work at all

Llama Guard's output schema declares `response` as `string | { safe, categories }` and **does not
say what selects between them**. The default is the string: asked plainly, the model answers with
the literal text `"\n\nsafe"`. Sending `response_format: { type: 'json_object' }` — a field its
input schema declares but none of its usage examples show — produces
`{ safe: true, categories: [] }` instead.

This was missed on first delivery and made every run of that model fail. The panel was _correct_ to
refuse the prose, which is the next section; it was wrong not to ask for the structured answer in
the first place. The requirement is declared on the model descriptor rather than applied to every
chat-shaped model, because it is a property of this model's contract, and a regression test asserts
the field is sent.

### One refusal is a security decision

Llama Guard's output type declares `response` as `string | { safe, categories }`. The structured
branch is read. The string branch is **refused, not parsed**.

A safety verdict extracted from prose by pattern-matching would be a security control resting on a
regular expression, and the failure mode runs in the dangerous direction: a parse that missed would
report unsafe content as _safe_. The same reasoning applies to a missing `safe` boolean — defaulting
to `true` would announce unverified content as safe, and defaulting to `false` would accuse it on
the strength of a malformed response. Both refuse.

### Why a decision model is a third classifier

The account's live catalogue holds 69 models, of which **two** are typed Text Classification — and
one of those is the reranker excluded below. Clef Flash, like Llama Guard, is typed _Text
Generation_. The difference is that Clef's contract deliberately accepts a state plus a typed
question schema, so it can perform target classification **when the target schema is owned by the
application rather than the caller**.

A live `cf ai run` against the exact immutable schema used here classified the neutral train-time
sentence as `NEUTRAL` with probability `0.9711`. That is the useful contrast with binary SST-2:
neutral is an actual reviewed label rather than a near-even split forced into one of two answers.

The obvious further candidates are Meta's other safety models, and both are unavailable rather than
unsuitable: `@cf/meta/prompt-guard-2-86m` and `@cf/meta/llama-guard-3-1b` exist but return
`5018 This account is not allowed to access`, while `llama-guard-4-12b` and
`llama-guard-3-11b-vision` are not in the catalogue at all. If access to the first two is granted
later, Prompt Guard would be the stronger addition: prompt-injection detection is a third kind of
answer again, distinct from both a scored ranking and a hazard verdict.

### Why the reranker was excluded

`@cf/baai/bge-reranker-base` is typed Text Classification and is deliberately **not registered**. It
does not classify a text: it scores the _relevance between a query and a list of passages_, taking
`{ query, contexts[] }` and returning `{ id, score }` pairs indexed into the caller's own array. Its
"labels" would be the caller's own passages — the precise opposite of the fixed-label contract.

It is not merely excluded, though: it is **reassigned to Semantic Search**, where scoring a query
against passages _is_ the panel's operation. Verified live, it answers a retrieval question with
0.98 for the matching passage against 0.00004 for the rest — a far more separable scale than cosine
similarity, which makes it the clearest way to show the retrieve-then-rerank trade-off that
production RAG systems make.

Worth recording separately: **the generated platform types for that model are wrong.** The
`Ai_Cf_Baai_Bge_Reranker_Base_Input` interface carries the JSDoc comment for `query` but omits the
field itself, while the published JSON schema lists it as required. Code written against those types
would not compile with a `query` and would fail at the provider without one.

### Smaller text limit, for a model reason

This panel accepts 1,500 characters where the other text panels accept more. DistilBERT is a BERT
derivative with a 512-token window, and text beyond it is **truncated by the model** — which returns
a confident-looking score for a prefix, with nothing in the response to say so. The limit keeps the
text inside that window, and the refusal explains why rather than letting the number look arbitrary.

### Reading the scores honestly

The reviewed classifier has no ranking fields in its schema, so top-k and the confidence floor are
applied by this application to the response, and the panel says so rather than implying the model
was asked to filter. The scores are never rescaled after filtering: a set that no longer sums to 1
is the honest consequence of hiding some, and adjusting them would be inventing output the model did
not produce.

The most instructive prepared passage is the neutral one. A binary classifier has no "neutral"
label, so neutral text produces a near-even split rather than a third answer — which is what a
closed label set really means, and exactly what a confidence bar can obscure.

## Semantic Search: retrieval before generation

Semantic Search ranks a small collection by **meaning**, not by matching words. It is deliberately a
retrieval demonstration rather than a miniature chat-with-documents product: the response names
passages by their position in the collection, never generates prose from them, and makes the vector
operation inspectable before anyone is invited to build on it.

The prepared **Meaning beats keywords** collection makes the distinction testable. The query is "How
do I reset my password?". The intended passage says "change your credentials" and shares no
important query word; a decoy says "password-protected" and "reset" but is about a door alarm. Live
BGE M3 testing ranked the intended answer at `0.7328`, the lexical decoy at `0.6777`, and the
cafeteria at `0.4169`. The cross-encoder makes the same judgement much more sharply: `0.9845`,
`0.00011`, and `0.000037`.

### Eight reviewed contracts, four vector spaces

| Model                    | Operation               | Live contract                                                                                    | What the panel teaches                                                                                                                                      |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BGE M3**               | Multilingual embedding  | `{ text: string[] }` → `{ data, shape, pooling, meta, response }`; `data` rows are 1,024 numbers | Default. An English password query matched French and Japanese support passages, so a vector can represent meaning across languages.                        |
| **EmbeddingGemma 300M**  | Embedding               | `{ text: string[] }` → `{ data, shape }`; rows are 768 numbers                                   | Different dimension count means a cosine score cannot be compared with BGE M3's, even when both look like `0.7`.                                            |
| **BGE Small EN v1.5**    | English embedding       | `{ text: string[] }` → `{ data, shape, pooling, usage }`; rows are 384 numbers                   | A smaller vector space is another useful comparison, not a lower-resolution version of another model's score.                                               |
| **PLaMo Embedding 1B**   | Embedding               | `{ text: string[] }` → `{ data, shape }`; rows are **2,048** numbers                             | The widest space in the panel and nearly the cheapest model in it, which breaks the assumption that more dimensions must cost more.                         |
| **BGE Base EN v1.5**     | English embedding       | `{ text: string[] }` → `{ data, shape, pooling, usage }`; rows are 768 numbers                   | Registered as a pair with BGE Large: same family and recipe, differing only in size. The panel's one controlled comparison.                                 |
| **BGE Large EN v1.5**    | English embedding       | `{ text: string[] }` → `{ data, shape, pooling, usage }`; rows are 1,024 numbers                 | Same width as BGE M3 from an unrelated model. Equal dimensions make two models' numbers _look_ comparable without making them so.                           |
| **Qwen3 Embedding 0.6B** | Embedding               | `{ text: string[] }` → `{ data, shape, usage }`; rows are 1,024 numbers                          | Roughly a seventeenth of BGE Large's price for the same output width — the sharpest cost comparison here, because the product looks identical.              |
| **BGE Reranker Base**    | Cross-encoder reranking | `{ query, contexts, top_k }` → `{ response: [{ id, score }] }`                                   | It reads each query/passage pair together and returns relevance directly. It produces **no vector** to cache, and its score scale is not cosine similarity. |

The seven embedding models span **four distinct vector widths — 384, 768, 1,024, and 2,048**.
Running one query across all four is the clearest demonstration of the panel's central claim: the
scores move while the ordering largely does not, because a cosine value is a position inside one
space rather than a measurement that transfers between them.

PLaMo is the one descriptor with **no context window**, and the omission is deliberate. Neither its
catalogue entry nor its documentation page publishes one, and a reviewed registry should not invent
a limit nobody reviewed. A test pins the absence so it reads as a finding rather than an oversight.

Every model was invoked with `cf ai run` before registration. The embedding envelopes differ — in
particular, only BGE M3 emits `meta`, and only some emit `usage` or `pooling` — so the Worker reads
only `data`, the common reviewed field. Each embedding model accepted a batch and returned one
vector per submitted text. Repeating the exact same text returned bit-identical vectors on every
reviewed embedding model, which establishes the cache's correctness rather than assuming it.

The reranker's generated platform type remains defective: its JSDoc describes `query`, but
`Ai_Cf_Baai_Bge_Reranker_Base_Input` omits the required field. The live provider rejects an omitted
query with `required properties at '/' are 'query,contexts'`; the Worker therefore sends the
reviewed plain record rather than trusting the generated interface.

### Similarity is not confidence

An embedding search maps the query and each passage into the selected model's vector space, then the
Worker ranks them locally with cosine similarity. The displayed number is a **relative position in
that one vector space**. It is not a probability that a passage is correct, a factual-confidence
measure, or something that can be compared to another model's score. The panel intentionally offers
no metric selector: the reviewed models return unit vectors, for which cosine similarity, dot
product, and Euclidean distance all give the same ranking. A selector would visibly do nothing.

The result includes a limited vector disclosure: dimension count, magnitude, and the first eight
components. It makes the representation concrete without pretending that one individual component
has a human-readable meaning. The full result JSON remains behind a disclosure for precise checking.

The cross-encoder's irrelevant scores collapse around `0.00004`; a matching password-reset passage
scored `0.9845`. Its proportional bars therefore leave most non-matches apparently empty. That is
not rescaled away: it is the result's real scale, explained in text, and a useful contrast with
cosine similarity's closer scores.

### Cache and cost shape

For an embedding model, the Worker embeds the query and only the passages it has not seen before,
then compares all vectors locally. A later unchanged search can make **zero** model calls; the panel
labels that as `not applicable` for cost, not `unavailable`, because there was truly nothing new to
measure. It reports the query/passage cache state per result and the actual aggregate inference-call
count in Run Details.

The cache is intentionally isolate-memory only: it demonstrates reuse in the current application
session without introducing KV, D1, R2, Vectorize, Terraform, a retention policy, or a new privacy
commitment. It stores vectors, never text; keys combine a content-derived hash, model identifier,
and the verified Access `sub`. That identity scope matters: sharing a cache across visitors would
reveal through a hit that someone else submitted byte-identical content, even if neither the text
nor the vector were displayed. An isolate recycle simply turns a later run into a cache miss, never
into an incorrect result.

The reranker has the opposite cost shape. It performs one request containing the query and whole
collection on every search and applies its own `top_k`; it cannot cache a passage score because a
score belongs to a specific query/passage pair. This is the retrieve-then-rerank trade-off
production RAG systems make: embeddings are cheap to reuse and broad to retrieve with; a
cross-encoder is a more discriminating second stage whose work scales with the collection on each
query.

## Evaluate Choices: a typed contract, not a prompt

Evaluate Choices asks a decision model **typed questions** about a situation and gets calibrated
probabilities back. It is the exact inverse of
[Classify Text](#classify-text-a-closed-set-of-answers), and the pair is deliberate: there the label
set belongs to the trained model and a caller-supplied label is refused; here the questions, the
types, the instructions, and the criteria are all the caller's.

What the caller cannot supply is a **prompt**. There is no `prompt`, `system`, `messages`,
`temperature`, or `response_format` field, and the server refuses a body carrying one with a `400`
that names the Chat panel instead. The panel's request preview shows the whole payload so the claim
is checkable rather than asserted. Nothing here parses text in either direction: there is no JSON
mode, no schema prompt-engineering, and no "please respond only with valid JSON" incantation.

`typesafe/jev` — the originally specified model — is not in the catalogue. Cloudflare's Clef models
are, which makes the purpose-built decision model the credit-free choice as well as the better one.

### Two reviewed models, one contract

| Model          | Size | Context       | Input price      | Output price |
| -------------- | ---- | ------------- | ---------------- | ------------ |
| **Clef**       | 27B  | 65,536 tokens | $0.24 / M tokens | none         |
| **Clef Flash** | 9B   | 65,536 tokens | $0.09 / M tokens | none         |

Running the same questions against both is the point of having two: the panel discards the previous
result when the model changes, because two models' probabilities for one question are different
judgements rather than interchangeable ones.

The **no output charge** is not a rounding convenience. Every verified call reported
`output_tokens: 0`, because a typed decision is not generated text — there is nothing to bill on the
way out. Beside a generative panel in the same session meter, that is a genuinely different cost
model rather than a cheaper version of the same one.

### Three question types, and one of them has no confidence

- **`noul`** — a truth-valued judgement returning a probability, never a boolean. `0.52` and `0.99`
  are different findings and the panel refuses to round either into "yes".
- **`choice`** — selection from named options, returning the chosen option, a probability for
  _every_ option, and a separate confidence.
- **`score`** — a graded rating over an ordered legend, returning a continuous score, a distribution
  across the legend, and a separate confidence.

A `noul` answer carries **no confidence field at all** in the reviewed contract, while the other two
do. That asymmetry is real, so the answer types are a discriminated union rather than one shape with
optional fields: a renderer cannot display a confidence that was never sent, because it would not
compile. The card says so in words rather than leaving a blank where a reader would expect one.

### Confidence is not the answer

The single most important thing this panel shows is that **the answer and the certainty are
independent**. Verified live against the same `choice` question:

| State                                                | Chosen        | Probability | Confidence |
| ---------------------------------------------------- | ------------- | ----------- | ---------- |
| "The server is on fire, total outage, nothing works" | `ENGINEERING` | 0.9831      | **0.9334** |
| "Hello"                                              | `ENGINEERING` | 0.7111      | **0.1782** |

The second answer looks decisive and is the model saying it is guessing. Prose output cannot express
that distinction at all — it reads as a confident sentence either way. So confidence is rendered as
its own control, below a dashed rule, with its own wording ("Very low confidence — treat this as a
guess"), and it is never folded into a probability bar or used to shade one.

### Several questions, one model call

Asking five questions about one state is **one gateway request**, not five. That is what a decision
model buys over a loop of classifier calls, and the panel shows the question count and the call
count side by side so the claim is visible rather than described.

### Structured state

The state can be free text or a JSON document, and the structured case is the more interesting one
because question instructions can reference fields by name. Given an order 40 days old and a policy
with a 30-day refund window, the model answered `within_window` at `0.0195` and `decision` as
`DECLINE` at `0.7784` — it compared two fields rather than matching words. The state's token count
is computed in the browser, borrowed from [View Tokens](#view-tokens), and shown against the model's
65,536-token window so a large state's cost is visible before anything is spent on it.

### Contract details worth knowing

Several rules below belong to the provider and are reimplemented in the domain layer so a refusal
can name the question a visitor is editing rather than a field in a payload they never saw:

- A `score` question's criteria are an **array**, while a `choice` question's are an **object**.
  Sending a legend as an object fails with `Input should be a valid list`.
- The body carries its own `model` field which must agree with the endpoint. Sending `"clef"` to the
  clef-flash endpoint fails with `Unsupported model 'clef'. Use 'clef-flash'.`
- Question names must match `^[A-Za-z0-9_.-]{1,100}$`, and `choice` and `score` need at least two
  entries. Criteria are optional for `noul`.
- Duplicate question names and duplicate option names are refused rather than deduplicated: the
  provider keys both by name, so a duplicate would silently discard one and return fewer answers
  than questions asked.

If the model answers some questions usably and one not, the usable answers are shown and the missing
one is **named** — a shorter card list with no comment is indistinguishable from never having asked.
