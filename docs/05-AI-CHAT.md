# Demo 5: AI Model Playground

Directory: `demos/ai-chat`

Domain: `ai-chat.cfapps.uk`

Cloudflare products: Workers, Static Assets, Cloudflare Access, and Workers AI.

## Tech Stack And Hosting Services

Everything runs on Cloudflare; there is no external host, database, or AI
provider in this demo.

**Hosting and platform services:**

- **Workers** — the single deployed unit: it serves the API and, through the
  `ASSETS` binding, the built browser application. Custom domain
  `ai-chat.cfapps.uk`.
- **Static Assets** (`ASSETS` binding) — hosts the built Vue SPA with
  `not_found_handling: single-page-application`; `run_worker_first` is limited to
  `/api/*`.
- **Workers AI** (`AI` binding) — serverless GPU inference. This is the one new
  product. It is an **account capability reached through a binding, not a
  provisioned resource**: there is nothing for Terraform to create and nothing
  for teardown to clean up.
- **Cloudflare Access** — one self-hosted application gating the whole hostname.
- **Workers Logs and automatic tracing** — the observability surface for the
  latency and token-usage lesson.

**Application stack:**

- TypeScript, **Hono** on the Worker; **Vue 3** + **Vuetify** + **Pinia** +
  **Vue Router** + **Feather Icons** in the browser; **Vite** with the Cloudflare
  Vite plugin builds both halves.
- `@adrianhall/cloudflare-toolkit` for `cloudflareLogger()`, RFC 9457 problem
  details, guards, `cloudflareAccess()` + `cloudflareAccessPlugin()`, testing
  helpers, and the `generate-wrangler` / `generate-wrangler-types` CLIs.
- **Terraform** (Cloudflare provider `~> 5.22.0`, `jrhouston/dotenv ~> 1.0`) for
  the Worker, bootstrap version/deployment, custom domain, observability, and
  Access application/policy. **Wrangler** owns code versions and deployments.
- **Vitest** with three projects (`worker`, `client`, `integration`) and
  `@vitest/coverage-istanbul`. No Playwright.

**Deliberately absent**: D1, KV, R2, Queues, Durable Objects, Workflows,
Vectorize, AI Gateway, and the Agents SDK. The conversation lives in the
browser tab; the Worker is stateless. Adding a store would teach nothing new
here and would contradict the scenario's "no persistent conversations" rule.

## Behavior

- Provide a **single-page chat playground**, styled with the Cloudflare palette,
  where a signed-in user picks a model from a small curated selector, adjusts a
  couple of validated parameters, and holds an ordinary multi-turn conversation.
- Run inference through the **`AI` binding** (`env.AI.run(model, { messages,
  stream: true, ... })`) — never through Cloudflare's REST API from inside the
  Worker, and never through an external provider.
- **Stream generated text to the browser** over Server-Sent Events as it is
  produced. The Worker does not buffer the answer before responding; the first
  token reaches the browser as soon as the model emits it.
- Show a **thinking/activity indicator** (animated dots) from submit until the
  first token arrives, so the model's cold-start and prefill time is visible
  rather than looking like a hang.
- For **reasoning models**, separate the model's internal reasoning from its
  answer and put the reasoning in a **collapsed "Thinking" panel** that fills in
  live, while the answer streams into the message body. For non-reasoning models
  no panel appears — the contrast is part of the lesson.
- Let the user **compare a deliberate selection of models and parameters**: the
  selector carries at least one non-reasoning model and at least one reasoning
  model, each labeled with its provider and whether it reasons; temperature and
  maximum output tokens are adjustable within **per-model** validated bounds
  (the models do not share one legal range).
- Allow **additional turns** once a response finishes, sending the accumulated
  conversation back with each request (the Worker keeps no state), and allow the
  user to **stop** an in-flight response, which cancels the upstream inference
  rather than merely hiding it.
- Show, at the end of each turn, that turn's **latency and token usage**
  (time-to-first-token, total time, prompt/completion tokens when the model
  reports them).
- Provide an **Export** control that downloads the whole conversation as a
  Markdown file, generated in the browser, including model, parameters,
  per-turn latency and token usage, and the thinking sections as collapsible
  `<details>` blocks.
- Write informational structured logs for prompt submission, first token,
  completion, cancellation, and failure — carrying model, latency, and token
  counts and **never** prompt or response content.

This is the curriculum's introduction to **Workers AI**. The one new lesson is
model inference over a binding plus **streaming a response to a browser**:
obtaining an async token stream from a binding, re-emitting it incrementally,
and rendering it progressively. Workers, Static Assets, and Cloudflare Access
are reused from earlier demos. No storage product is used at all, which is the
point: the Worker is a stateless streaming proxy in front of a model.

## Out Of Scope

Persistent or server-side conversations, tool/function calling, RAG or
Vectorize, agents, external model providers, AI Gateway (demo 6), and audio
recording or speech-to-text (demo 7). Do not add a "chat history" list, a
database, or a Durable Object.

## Demo Flow

1. Open `https://ai-chat.cfapps.uk/` and sign in through Cloudflare Access. The
   header shows the verified identity and a logout control.
2. Pick the **small, fast, non-reasoning model** (Granite 4.0 H Micro — the
   cheapest entry, and the default selection) from the selector, type a
   prompt, and submit. Watch the activity dots, then the answer arriving **token
   by token** rather than appearing all at once. The turn ends with its latency
   and token usage.
3. Ask a **follow-up question** that depends on the previous answer, showing that
   the conversation context is being sent with each request even though the
   Worker stores nothing.
4. Switch to a **reasoning model** and ask a question that requires working
   something out. A collapsed **"Thinking"** panel appears and fills in first;
   expand it to show the model's reasoning, then collapse it and watch the final
   answer stream below it.
5. Raise the temperature, resubmit a similar prompt, and note the different
   character of the response — the "small selection of models and parameters"
   comparison.
6. Start a long generation and press **Stop** mid-stream; the response halts
   immediately and the turn is marked as stopped.
7. Press **Export** and open the downloaded Markdown transcript, showing the
   models, parameters, per-turn latency, token usage, and the preserved
   thinking sections.
8. Open **Workers Logs** and locate `ai_prompt_submitted`,
   `ai_first_token`, `ai_stream_completed`, and `ai_stream_aborted`, correlated
   by request. Point out that they carry model, TTFT, total duration, and token
   counts — and that **no prompt or completion text appears anywhere in the
   logs**.
9. Open the Cloudflare dashboard's **Workers AI** metrics to show the same
   activity from the product side (requests per model, neurons consumed).

## Relevant Skills

**Cloudflare / backend skills:**

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`

**Vue / UI skills:**

- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

Skills do not replace current documentation. Retrieve the current Workers AI
model catalog, the pinned Terraform provider schema, Workers types, the Wrangler
schema, and the remote-bindings documentation before relying on model IDs,
input/output shapes, pricing, limits, or command options. The model catalog in
particular changes frequently — treat every model ID in this document as a
candidate to re-verify, not as fact.

## Access Model

Inference is **billable compute**, so no route in this demo may be anonymous.
Following `demos/chat`, the **entire `ai-chat.cfapps.uk` hostname** is gated by a
single Cloudflare Access self-hosted application backed by an `allow` policy
requiring authentication through a configured identity provider. There is **no**
public bypass application.

- The SPA shell is served by the `ASSETS` `single-page-application` fallback and
  gated at the edge by Access before the request reaches the Worker, so page
  routes need no Worker route or `run_worker_first` entry.
- `cloudflareAccess()` is mounted **once, globally** in `src/worker/index.ts`.
  Following `demos/todo-app` and `demos/chat`, this demo does **not** validate
  the Access `audience`; it derives the caller's identity (email) from the
  verified Access identity on every request and never from client input.
- `src/access-policies.ts` is **fail-safe**, exactly as in `demos/chat`:
  `/api/*` → `authenticate: true, redirect: false` (so a `fetch()` receives a
  `401`/`403` instead of an HTML sign-in redirect), then a catch-all `/` →
  `authenticate: true, redirect: true` for pages. Every entry authenticates, so
  a route added later cannot accidentally become public.
- Because any authenticated user is a legitimate user of the playground, no
  per-email allowlist is needed. `README.md` MUST nevertheless document how to
  tighten the Access policy (specific emails, an email domain, or a group) for
  operators who want stricter cost control, since a permissive identity provider
  such as one-time PIN would otherwise make paid inference broadly reachable.
  Per-request input caps (below) are the in-application half of that control.

One Access subtlety this demo introduces: **a session can expire mid-conversation
between turns.** The browser POSTs to a same-origin `/api/*` URL, so the Access
cookie travels with it, but if the session has lapsed the response is a `401`
with a JSON body, not an event stream. The client MUST check the response status
and `Content-Type` **before** it starts reading the body as SSE, and surface a
clear "your session expired, sign in again" state instead of failing to parse
HTML or JSON as event-stream frames.

## Model Catalog

`src/models.ts` is the single source of truth, imported by both the Worker (for
validation and adapter selection) and the client (for the selector). It exports
a readonly array of descriptor **objects** — an identifier, a display name, and
an adapter identifier, plus the metadata the UI and validation need — so the
catalog can be extended by adding an entry and, at most, one adapter:

```ts
{
  id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  displayName: "DeepSeek R1 Distill Qwen 32B",
  provider: "DeepSeek",
  adapter: "cf-native", // ModelAdapterId
  // "inline-think-tags" | "reasoning-field" | "none"
  reasoning: "inline-think-tags",
  contextWindow: 80_000,
  temperature: { default: 0.6, min: 0, max: 5 },
  maxOutputTokens: { default: 1024, max: 4096 },
}
```

Rules for the catalog:

1. Keep it **small and deliberate** — around five entries. It MUST include at
   least one **non-reasoning** model and at least one **reasoning** model, so
   both the Thinking panel and its absence can be demonstrated.
2. Every entry MUST name an `adapter` that already exists or is added with it.
   Workers AI models do **not** share one request/response shape (see
   "Model Adapters" below), so the descriptor — not the route handler — decides
   how a model is called and how its stream is read.
3. Do not include deprecated models. Verify each entry against the live catalog
   at <https://developers.cloudflare.com/workers-ai/models/> and confirm its
   streaming behavior with a throwaway spike before committing the list.
4. The Worker MUST resolve a requested model by **exact match against this
   array** and reject anything else with a `400`. Never interpolate a
   client-supplied string into a model ID.
5. Declare the array `as const` and type `id` against the generated `AiModels`
   keys, so `env.AI.run()` resolves to its known-model overload and an input
   shape that does not match the model becomes a type error rather than a
   silent fallback to `Record<string, unknown>`.

The starting set, verified against the live catalog on 2026-07-31, **and re-verified
against a live streaming spike on the deployed account the same day** (see the
correction below the table — the spike found one wrong bound the catalog page
itself does not surface):

| `id` | Provider | Adapter | Reasoning | Context | Temperature |
| --- | --- | --- | --- | --- | --- |
| `@cf/zai-org/glm-4.7-flash` | Zhipu AI | `openai-chat` | `reasoning-field` | 131,072 | 0–2 |
| `@cf/google/gemma-4-26b-a4b-it` | Google | `openai-chat` | `reasoning-field` | 256,000 | 0–2 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Meta | `cf-native` | `none` | 131,000 | **0–2** |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | DeepSeek | `cf-native` | `inline-think-tags` | 80,000 | 0–5 |
| `@cf/ibm-granite/granite-4.0-h-micro` | IBM | `cf-native` | `none` | 131,000 | 0–5 |

**Spike correction (temperature): Llama 4 Scout's real range is 0–2, not 0–5.**
The catalog page and the generated `AiTextGenerationInput` type both suggest the
same 0–5 range as Granite and DeepSeek, since all three share that permissive
type. Sending Scout `temperature: 3.5` in the live spike returned a `400` from
Workers AI itself (`temperature must be in [0, 2], got 3.5`). Granite and
DeepSeek really do accept up to `5` (confirmed: `5` succeeds, `5.5` is rejected
by Granite). This is exactly the scenario the per-descriptor (not per-adapter)
clamp bounds exist to catch — see "Model Adapters" below for why one shared
`cf-native` input *type* does not imply one shared valid *range*.

Why Granite 4.0 H Micro is the fifth entry, rather than any other
non-reasoning model:

- It needs **no sixth adapter**. Its documented input is `max_tokens`
  (default 256), `temperature` default 0.6 across 0–5, `messages`; its output is
  `{ response, usage, tool_calls }` — the existing `cf-native` adapter exactly.
  In the generated Workers types it maps to the shared `BaseAiTextGeneration`
  (`AiTextGenerationInput` / `AiTextGenerationOutput`), as DeepSeek R1 does.
- Its documented output includes **`usage`**. This is the reason to prefer it
  over `@cf/meta/llama-3.1-8b-instruct-fast`, whose documented output lists only
  `response` and `tool_calls` — a model that reports no usage would silently
  hand the UI a `null` token count and undercut the usage-logging lesson.
- It adds a **fifth provider** (IBM) rather than a third Meta model, and at
  **$0.017 / $0.11 per M input/output tokens** it is by far the cheapest entry —
  so it is the natural default selection and the "small and fast" side of the
  latency comparison.

Corrections and cautions on that set:

- The Zhipu AI model ID is **`@cf/zai-org/glm-4.7-flash`**, not `@cf/zai/...`.
  The catalog page and every code sample use `zai-org`.
- Llama 4 Scout and Granite 4.0 H Micro are the **two non-reasoning entries**.
  Keep at least one: without one, the "no Thinking panel for a non-reasoning
  model" half of the lesson disappears and the reasoning splitter is never
  exercised in its pass-through path from the UI.
- Gemma 4 and Llama 4 Scout are also vision models. This demo sends **text
  only**; do not add image input, and do not advertise vision in the selector.
- Granite and DeepSeek R1 map to the permissive shared `BaseAiTextGeneration`
  type, while GLM, Gemma, and Scout have generated per-model interfaces. The
  loose type will accept a misspelled or wrong-adapter field without
  complaint, so the spike — not the compiler — is what confirms those two.

No `GET /api/models` endpoint is needed: the catalog is static build-time data
that both halves import, so an endpoint would add a round trip and a second
source of truth. The Worker still validates against it on every request. The
client imports only the descriptors — never an adapter implementation.

## Model Adapters

**Answering the open question in the catalog notes: yes, an adapter identifier
is required, not optional.** The five chosen models do not share one interface.
Verified from the model pages and the Workers AI types on 2026-07-31 — then
**re-verified with a live throwaway streaming spike against the deployed
account the same day**, which found the real *streaming chunk shape* is not
what either the model pages or the generated types predict for two of the
three `cf-native`-typed models. Do not implement `readChunk()` from the table
below without first reading the correction underneath it.

| | `cf-native` **input type** (Scout, DeepSeek R1, Granite) | `openai-chat` **input type** (GLM 4.7 Flash, Gemma 4) |
| --- | --- | --- |
| Output token limit field | `max_tokens` (**default 256**) | `max_completion_tokens` (`max_tokens` deprecated) |
| Temperature range | 0–5 for Granite/DeepSeek, **0–2 for Scout** (per-descriptor, not per-adapter — see the catalog correction above) | 0–2 |
| Non-streaming output | `{ response, usage, tool_calls }` | `{ id, object, created, model, choices[], usage }` |

**Spike correction (streaming shape): the input-type split above does *not*
predict the streaming chunk shape.** Calling `env.AI.run(model, { messages,
stream: true })` on the live account returns, per model:

| Model | Every per-token chunk shape | Terminal chunk (immediately before `[DONE]`) |
| --- | --- | --- |
| DeepSeek R1 Distill | `{ response: "<text>", usage }` — the true "raw cf-native" shape, no `choices` at all | `{ response: "", usage: <cumulative totals> }` |
| Granite 4.0 H Micro | `{ choices: [{ delta: { content }, finish_reason }], usage }` — **OpenAI delta shape**, despite its `AiTextGenerationInput`-typed input | same terminal shape as DeepSeek |
| Llama 4 Scout | `{ choices: [{ delta: { content }, finish_reason }], response, usage }` — OpenAI delta shape, *and* a redundant top-level `response` mirror | same terminal shape as DeepSeek |
| GLM 4.7 Flash | `{ choices: [{ delta: { content?, reasoning_content? }, finish_reason }], usage }` | same terminal shape as DeepSeek |
| Gemma 4 | `{ choices: [{ delta: { content?, reasoning_content? }, finish_reason }], usage }` | same terminal shape as DeepSeek |

So only **DeepSeek R1 Distill** actually streams the raw `{ response }`
cf-native shape end to end. Granite and Scout accept the same `cf-native`
*input* type (`max_tokens`, no `stream_options`) but stream back **the other
adapter's chunk shape**. Consequently `src/worker/chat/adapters/cf-native.ts`'s
`readChunk()` must itself handle both physical shapes it may receive — checking
for a `choices` array first (Granite/Scout) and falling back to the plain
`response` field (DeepSeek) — while `buildInput()`/`run()` stay keyed on the
`AiTextGenerationInput`-compatible input type shared by all three models. The
`openai-chat` adapter's `readChunk()` only ever sees the `choices` shape, so it
stays simple. A small `src/worker/chat/adapters/shared.ts` holds the
`choices`-shape parsing and `usage` normalization used by **both** adapters,
so that duplicated logic (not model-invocation logic — each adapter still owns
its own `env.AI.run()` call site) is implemented once.

**Spike correction (usage timing): usage is not cumulative per delta.** Every
per-token chunk carries its own small `usage` object (typically
`completion_tokens: 1`, describing just that delta) — not a running total. The
one **terminal** chunk immediately before `[DONE]` is the only frame carrying
the true cumulative `{ prompt_tokens, completion_tokens, total_tokens }` for
the whole turn, and it has the identical `{ response: "", usage }` shape for
**every** model regardless of adapter. The correct extraction rule proven by
the spike is therefore "last `usage` value seen before `[DONE]` wins", not
"sum every delta's `usage`" and not "only trust a `choices`-shaped terminal
frame" (DeepSeek never has `choices` at all).

**Spike correction (`stream_options.include_usage`): usage was present in the
terminal frame even without this flag during the spike**, contradicting the
model pages' documented requirement. The flag is still sent — it is the
documented, forward-compatible way to request it, cheap to include, and this
finding may not hold on every account/gateway version — but do not treat its
absence as proof usage will be `null`; verify empirically per account.

So the demo needs `src/worker/chat/adapters/` with a registry keyed by
`ModelAdapterId` (the literal union declared in the shared `src/models.ts`) and
one module per adapter, each colocated with its own tests, plus the shared
`choices`-parsing/usage-normalization helper above. Every adapter exposes the
same two operations:

- `buildInput(descriptor, messages, params)` — produce that model's input
  object, mapping the clamped `maxTokens` onto the correct field name and the
  clamped `temperature` onto the correct range (per descriptor — Scout's 0–2
  differs from Granite/DeepSeek's 0–5 despite sharing an adapter), and adding
  `stream_options: { include_usage: true }` on the `openai-chat` side.
- `readChunk(parsedChunk)` — return `{ answerDelta?, thinkingDelta?, usage?,
  finishReason? }` from one already-JSON-parsed upstream SSE frame.
  `thinkingDelta` is populated here only when the JSON already separates it
  (`reasoning_content`, `openai-chat`'s job); the `inline-think-tags` mechanism
  is **not** an adapter concern — `readChunk()` returns the raw combined text
  as `answerDelta`, and a later stage (`src/worker/chat/reasoning.ts`, driven
  by the descriptor's `reasoning` field, not the adapter) re-splits it.

Each adapter owns its own `env.AI.run()` call site so the model-ID union and
input type stay narrow within it. Do not build one generic call site for all
models: with two different input types, that only type-checks behind an
`as never`-style cast, which is exactly the mistake the typed overloads exist to
prevent.

Two traps worth naming, because both produce plausible-looking wrong output:

- **`max_tokens` defaults to 256 on all three `cf-native`-input models.** Left
  unset, every answer silently truncates mid-sentence and the demo looks
  broken. Always send an explicit value from the descriptor.
- **Reading `choices[0].delta.content` only for the two `openai-chat`-input
  models would silently drop Granite's and Scout's entire streamed answer**,
  since those two `cf-native`-input models emit exactly that shape, not
  `response`, per the spike above. This is the single easiest way to "carry a
  documented shape into code unverified" that the spike step exists to prevent.

`reasoning_effort` exists on the `openai-chat` models. Deliberately do **not**
expose it: two parameters (temperature and output limit) are enough for the
comparison lesson, and a third that works on only two of the five entries would
make the selector's behavior inconsistent.

## Streaming Protocol

The Worker consumes the model's stream and **re-emits its own** event stream.
It does not pipe the provider's SSE bytes through to the browser.

Note what `env.AI.run()` actually returns: with `stream: true` its typed
overload resolves to `Promise<ReadableStream>` — **raw SSE bytes**, not an async
iterable of parsed objects. Some third-party examples show
`for await (const chunk of stream) { chunk.response }`; that is not the current
contract. The Worker must therefore decode UTF-8, buffer, split frames on a
blank line, strip the `data: ` prefix, recognize the terminal `[DONE]` sentinel,
and `JSON.parse` each payload itself, then hand the parsed object to the model's
adapter. Put that decoder in a shared `src/sse.ts` and reuse it for **both**
directions — the Worker reading the model's stream and the client reading the
Worker's stream — so the frame-splitting edge cases are implemented and tested
exactly once.

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`.

Frames are one JSON object per `data:` line, discriminated by `type`, with the
shared types declared in `src/chat-protocol.ts` (imported by Worker, client, and
tests):

- `{ type: "start", model, requestId }` — sent immediately, so the browser can
  confirm the stream opened and correlate with logs.
- `{ type: "thinking", text }` — a reasoning delta.
- `{ type: "answer", text }` — an answer delta.
- `{ type: "done", finishReason, ttftMs, totalMs, usage }` where `usage` is
  `{ promptTokens, completionTokens, totalTokens }` — normalized from the
  upstream `prompt_tokens` / `completion_tokens` / `total_tokens` — or `null`
  when the model reports none.
- `{ type: "error", status, title, detail }` — a failure that occurred **after**
  the first byte, when the HTTP status can no longer change.

Why re-emit rather than proxy:

- **The catalog is not shape-homogeneous.** Three of the five models stream
  `response`, the other two stream `choices[0].delta.content`. Proxying would
  push that difference into the browser, and into demo 6 and demo 7 after it.
- **Reasoning has to be separated** from the answer, which requires inspecting
  the text or the reasoning field server-side.
- The **`done` frame is where latency and usage are measured and logged**; there
  is no other point at which the Worker knows the turn is complete.
- It keeps provider-internal fields out of the response.

Reasoning normalization is the most bug-prone code in the demo, and the catalog
exercises **both** mechanisms — so both are mandatory, dispatched by the
descriptor's `reasoning` field, not guessed at runtime:

- `reasoning: "reasoning-field"` (`openai-chat` models) — the adapter returns
  `delta.reasoning_content` as `thinkingDelta` directly. No text parsing.
- `reasoning: "inline-think-tags"` (DeepSeek R1) — a pure state machine in
  `src/worker/chat/reasoning.ts` splits `<think>` / `</think>` out of the text
  stream. Those markers **can be split across chunk boundaries** (`"<th"` then
  `"ink>"`), so the splitter must hold back a partial-marker tail rather than
  emit it as answer text, and an **unclosed** `<think>` at end of stream must be
  flushed as thinking rather than dropped.
- `reasoning: "none"` (Llama 4 Scout, Granite 4.0 H Micro) — every delta is
  `answer`; the splitter is bypassed entirely.
- Belt and braces: a model declared `"none"` or `"reasoning-field"` should still
  never leak a literal `<think>` into the visible answer. Verify each entry's
  real behavior in the spike; if a model contradicts its declared mechanism, fix
  the descriptor rather than adding runtime sniffing.

Error and cancellation behavior:

- A failure **before** the first byte (validation, `AI.run()` rejecting, an
  unavailable model) is an ordinary RFC 9457 JSON response with a real status
  code — `400` for invalid input, `413` for an oversized body, `502` for an
  upstream inference failure (map Workers AI error codes such as model-not-found,
  input-validation, rate-limited, and context-exceeded onto distinct details).
- A failure **after** the first byte becomes an `error` frame followed by closing
  the stream.
- If the client aborts, the outgoing stream's `cancel()` MUST cancel the upstream
  reader so inference stops instead of billing for output nobody reads. Log
  `ai_stream_aborted`.
- **Do not** hand the pump to `ctx.waitUntil()`; its lifetime is the response
  stream's lifetime. Await or explicitly tie every promise to that stream.
- Never accumulate the full answer in a Worker variable. Track **counts** for
  logging, not content.

## API And Routing

All routes are authenticated and live under `/api/*` (the only paths in
`run_worker_first`):

- `GET /api/me` — the verified identity, for the header.
- `POST /api/chat` — the streaming inference endpoint.

`POST /api/chat` accepts
`{ model, messages: [{ role: "user" | "assistant", content }], temperature?,
maxTokens? }` and validates, before any call to `env.AI.run()`:

- `model` is an exact member of the catalog.
- `messages` is non-empty, alternates plausibly, and its **last entry is a
  `user` message**.
- Roles are **only** `user` or `assistant`. A client-supplied `system` message is
  rejected — the system prompt is a server-owned constant, so a caller cannot
  redefine the assistant's instructions.
- Per-message length, total conversation characters, and message count are all
  capped (a body-limit middleware plus explicit field checks). These caps are the
  demo's cost and abuse control; document their values.
- `temperature` and `maxTokens` are clamped to the selected model's catalog
  bounds rather than trusted.

Everything else is an RFC 9457 problem details response.

## Workers AI Has No Local Simulation

This is the single most important operational fact about this demo, and it shapes
the Wrangler config, local development, and every test. Verify each point below
against current documentation during Phase 1, and record the outcome in
`docs/DECISIONS.md`.

- Workers AI **has no local simulator**. The binding must be declared
  `{ "binding": "AI", "remote": true }`. Cloudflare **errors** if `remote` is
  `false`, and warns (while still connecting remotely) if it is omitted.
- Therefore `vite dev` proxies inference to the real account and needs
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Wrangler reads system
  environment variables from a `.env` file **in the same directory as the
  Wrangler config**, which is exactly where this repo already keeps them, so no
  new mechanism and no `TF_VAR_*`-style export should be required. Verify this;
  if Wrangler does not pick them up, document exporting the two variables in
  `README.md` rather than inventing a wrapper script.
- The committed `.dev.vars` earns its keep twice here: it sets a local
  `ENVIRONMENT`, and because Wrangler ignores `.env` for the Worker's `env`
  object when `.dev.vars` exists, it also keeps the deployment token out of
  `env`. Verify that behavior and comment it in the file — a Worker must never be
  able to read the account's API token.
- `vite build` does **not** open a remote session, so a clean checkout with no
  credentials still builds and type-checks. Keep it that way.
- `@cloudflare/vitest-pool-workers` starts a remote proxy session for **any**
  binding that has no local simulator — including `ai`, and **regardless of the
  `remote` flag**. Left alone, `npm test` on a clean checkout would demand
  credentials and network access. The integration project MUST therefore set the
  pool's `remoteBindings: false` option. `env.AI` then exists but is
  non-functional, which is correct: tests supply their own model.
- Consequently, integration tests drive the Worker by importing the Hono app and
  calling `app.fetch(request, { ...env, AI: fakeAi }, ctx)` with
  `createExecutionContext()` / `waitOnExecutionContext()` from `cloudflare:test`,
  rather than `SELF.fetch()`. Everything except the model is real: real
  `workerd`, real `TransformStream`, real SSE bytes, real Access middleware. The
  fake `Ai` yields a scripted chunk sequence, which is what makes assertions
  about ordering, marker splitting, usage, and cancellation deterministic — a
  live model could not provide that.
- The one thing that cannot be automated is real inference. Provide a documented
  **manual smoke check** in `README.md` (deployment verification) and `DEMO.md`
  (presenter rehearsal): submit one prompt to each catalog model on the deployed
  hostname and confirm streaming, the Thinking panel, and reported usage.

## Implementation Plan

### Phase 1 — Scaffold and baseline infrastructure

1. Create an independent `demos/ai-chat` demo using Vue 3, Vuetify, Pinia, Vue
   Router, Vite, Hono, and TypeScript, following the canonical
   `demos/url-shortener` / `demos/chat` layout (`infra/`, `src/worker/`,
   `src/client/`, `tests/integration/`, `.env.example`, `README.md`, `DEMO.md`,
   `biome.json`, `tsconfig.json`, `vite.config.ts`, root `vitest.config.ts`).
2. Provision the baseline resources with Terraform: a Worker (with an explicit
   `subdomain` block matching the template's `workers_dev` / `preview_urls`), the
   `ai-chat.cfapps.uk` custom domain (with the one-time inert bootstrap
   version/deployment so `cloudflare_workers_custom_domain` can attach without
   error `100124`), Workers Logs, and automatic tracing with explicit sampling.
   Read all configuration from `../.env` via the `dotenv` provider; set
   `DEMO_NAME=ai-chat` and `DEMO_DOMAIN=cfapps.uk`. Export `worker_name`,
   `hostname`, `environment`, and `cloudflare_team_domain`.
   **Workers AI needs no Terraform resource** — it is an account capability
   reached through a binding — so the Worker has **no** `depends_on` for it, and
   teardown has no product-specific cleanup step. Say so in a comment beside the
   Worker resource so the omission reads as deliberate.
3. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for every
   Terraform-sourced value (`worker_name`, `cloudflare_team_domain`,
   `environment`). Declare `"ai": { "binding": "AI", "remote": true }` (see
   "Workers AI Has No Local Simulation"), configure `assets` with
   `not_found_handling: single-page-application` and `run_worker_first:
   ["/api/*"]`, set `upload_source_maps: true`, `workers_dev: false`,
   `preview_urls: false`, and a current `compatibility_date`. Do **not** enable
   `nodejs_compat` — nothing here needs Node APIs. Add a committed
   `infra/local-outputs.json` with the three hardcoded local values; wire
   `generate-wrangler -c -l infra/local-outputs.json` into `prebuild`,
   `prestart`, `precheck:types`, `pretest`, `pretest:coverage`, and
   `pretest:integration` (each as `run-s generate:wrangler:local
   generate:types`). Generate binding types from `wrangler.jsonc`; never
   hand-maintain the binding interface. Commit a `.dev.vars` (no secrets) that
   sets a local `ENVIRONMENT`, with a comment explaining both reasons it exists.
4. Mirror `demos/chat`'s `package.json` scripts minus everything D1-related (this
   demo has no migrations): `build`, `check:*`, `format:*`, `generate:*`,
   `start`, `test*`, `deploy` (`deploy:infra` then `deploy:worker`, with
   `predeploy:worker` running `generate-wrangler -cf --terraform infra` plus
   `generate:types`), `teardown`, and a `postteardown` that removes the generated
   `wrangler.jsonc` and `worker-configuration.d.ts`.

### Phase 2 — Cloudflare Access (authenticated identity)

5. Gate the entire `ai-chat.cfapps.uk` hostname with one Cloudflare Access
   self-hosted application backed by an `allow` policy requiring authentication
   through a configured identity provider — **no** bypass policy, following
   `demos/chat`. The SPA shell is gated at the edge before the request reaches
   the Worker or the assets layer.
6. Mount `cloudflareAccess()` **once, globally** in `src/worker/index.ts`. Do
   **not** validate the audience; derive the caller's email from the verified
   Access identity on every request, never from client input. Implement
   `GET /api/me` from that verified identity.
7. Add `src/access-policies.ts` exporting the fail-safe path-policy array shared
   by the Worker middleware and the Vite plugin: `/api/*` →
   `authenticate: true, redirect: false`; catch-all `/` →
   `authenticate: true, redirect: true`.
8. Configure `cloudflareAccessPlugin()` in `vite.config.ts` **before**
   `cloudflare()`, passing the same array, with selectable dev `users` matching
   `.env.example` defaults so local sign-in is one click, and development tokens
   enabled only behind `import.meta.env.DEV`. Render an unconditional control
   navigating to `/cdn-cgi/access/logout`.

### Phase 3 — Worker: model catalog and streaming inference (the core lesson)

9. Run a short throwaway spike against the deployed account **before** writing
   the catalog: for each candidate model, stream one prompt and record the real
   frame shape, where reasoning appears, whether `usage` arrives (and whether
   `stream_options.include_usage` is needed), and the terminal-chunk format.
   Correct the descriptors and the adapter table in this document from what the
   spike observes; do not carry a documented shape into code unverified.
10. Add `src/models.ts`: the JSDoc'd `ModelDescriptor` type, the
    `ModelAdapterId` and reasoning-mechanism literal unions, the curated
    readonly (`as const`) catalog with `id` typed against the generated
    `AiModels` keys, and a `findModel(id)` lookup returning `undefined` for
    anything not in the array (see "Model Catalog"). This module is imported by
    the client, so it must contain data and pure lookups only — no adapter
    implementations, no Worker imports.
11. Add `src/chat-protocol.ts`: the request body type and the discriminated
    stream-frame union from "Streaming Protocol", imported by the Worker, the
    client, and the tests, so the wire contract has exactly one definition. Add
    `src/sse.ts`: the shared frame decoder (UTF-8 decode, buffer, split on blank
    line, strip `data: `, recognize `[DONE]`) used by the Worker to read the
    model's stream and by the client to read the Worker's stream.
12. Implement `src/worker/chat/validation.ts`: parse and validate the request
    body (model membership, non-empty messages ending in a `user` turn,
    `user`/`assistant` roles only, per-message and total character caps, message
    count cap) and clamp `temperature` / `maxTokens` to **that descriptor's**
    bounds — the ranges genuinely differ between adapters (0–5 versus 0–2), so
    one global clamp is wrong. Reject a client-supplied `system` role; the
    system prompt is a server-owned constant in this module. Pair it with a
    request body-limit middleware under `src/worker/middleware/`.
13. Implement `src/worker/chat/adapters/`: the registry keyed by
    `ModelAdapterId` plus one module per adapter (`cf-native.ts`,
    `openai-chat.ts`), each with colocated tests and each owning its own
    `env.AI.run()` call site, exposing `buildInput()` and `readChunk()` as
    described in "Model Adapters". `buildInput()` MUST always set the output
    token limit explicitly (`max_tokens` versus `max_completion_tokens`) and MUST
    set `stream_options: { include_usage: true }` for the `openai-chat` adapter.
    Take the `Ai`-shaped binding as a parameter so tests can substitute one.
14. Implement `src/worker/chat/reasoning.ts`: the pure inline-`<think>` splitter,
    handling markers split across chunk boundaries, an unclosed marker at end of
    stream, and the pass-through case. It is used only for descriptors declaring
    `reasoning: "inline-think-tags"`; the `"reasoning-field"` and `"none"`
    mechanisms bypass it. This module carries the demo's highest defect risk;
    unit-test it hard.
15. Implement `src/worker/chat/inference.ts`: read the upstream
    `ReadableStream` of SSE bytes with the shared `src/sse.ts` decoder, hand each
    parsed frame to the descriptor's adapter, apply the reasoning mechanism, and
    yield a normalized `{ answerDelta, thinkingDelta, usage, finishReason }`
    sequence. Map Workers AI failures (model not found, input validation, rate
    limited, context exceeded) onto RFC 9457 problem details with distinct
    causes.
16. Implement `src/worker/chat/stream.ts`: the SSE encoder and the pump that
    writes `start`, then `thinking` / `answer` deltas as they arrive, then
    `done`; measures TTFT and total duration; converts a post-first-byte failure
    into an `error` frame; and propagates consumer cancellation upstream. Return
    the response with the streaming headers and **no buffering**. Do not use
    `ctx.waitUntil()` for the pump.
17. Implement `src/worker/routes/chat.ts` and `src/worker/routes/me.ts`, mounted
    from `src/worker/index.ts` (routing only), with `src/worker/bindings.ts` as
    the single `AppBindings`/`AppVariables` definition and the toolkit's Hono
    error handler for problem details.
18. Emit informational structured logs via `cloudflareLogger()` —
    `ai_prompt_submitted`, `ai_first_token`, `ai_stream_completed`,
    `ai_stream_aborted`, `ai_inference_failed` — each placed **after** the Access
    and validation guards so they only reflect authorized, valid requests. Build
    every payload through a pure `buildInferenceLogFields()` helper that emits
    model, TTFT, total duration, token counts, message count, and character
    counts, and **structurally cannot** include prompt or completion text,
    tokens, authorization headers, or the Access JWT. Unit-test that guarantee
    directly.

### Phase 4 — Browser application

19. Build a focused, responsive single-view Vue 3 + Vuetify playground using the
    Cloudflare palette and Feather Icons, meeting WCAG 2.2 AA on desktop and
    mobile:
    - A model selector showing `displayName`, provider, and a reasoning
      indicator, defaulting to the cheapest non-reasoning entry (Granite 4.0 H
      Micro) so an accidental first prompt is the cheapest possible one, plus
      temperature and max-token controls whose bounds come from the
      **selected descriptor** and therefore change when the model changes —
      re-clamp the current values on switch rather than leaving an out-of-range
      temperature selected. Changing the model mid-conversation is allowed and
      recorded per turn.
    - A message transcript with user and assistant turns; each assistant turn
      renders a collapsed **Thinking** expansion panel (only when the model
      produced reasoning) above its streaming answer, and a footer with TTFT,
      total duration, and token usage once `done` arrives.
    - Animated activity dots between submit and first token, honoring
      `prefers-reduced-motion`.
    - A composer that sends on submit and clears, a **Stop** control that aborts
      the in-flight request, and an **Export** control.
    - The verified identity and an unconditional `/cdn-cgi/access/logout`
      control in the header.
    - Accessibility specifics: announce streaming answer text through a polite
      live region without re-announcing the whole transcript on every token;
      label every control; keep the composer and Stop reachable and operable by
      keyboard alone; meet target-size and contrast requirements; and manage
      focus so a finished response does not steal focus from the composer.
20. Add the client's stream reader on top of the shared `src/sse.ts` decoder: an
    async generator that turns the response body into typed `chat-protocol`
    frames, and that **first** rejects any response whose status or
    `Content-Type` is not a successful event stream (the expired-Access case)
    with a typed error. Do not write a second frame decoder here.
21. Manage state in Pinia: a `session` store (identity), a `settings` store
    (selected model and parameters, kept in memory only), and a `chat` store
    owning the transcript, per-turn streaming state, the `AbortController`, and
    the accumulated usage. Add a pure `src/client/lib/transcript.ts` that builds
    the Markdown export (models, parameters, turns, latency, usage, thinking as
    `<details>`) separately from the browser download trigger, so the formatting
    is unit-testable. Keep `src/client/main.ts` bootstrap-only with `App.vue`,
    `views/`, `stores/`, `components/`.

### Phase 5 — Tests, deployment, and documentation

22. Add the three Vitest projects listed from a root `vitest.config.ts`:
    - `src/worker/vitest.config.ts` (`environment: node`, `name: worker`):
      request validation and per-descriptor clamping (including a value legal
      for one adapter's range but not the other's), catalog lookup and rejection
      of unknown or non-exact model IDs, the shared SSE decoder (frames split
      across byte chunks, `[DONE]`, blank-line handling), **both adapters'**
      `buildInput()` (correct token-limit field name, explicit limit always set,
      `include_usage` present only for `openai-chat`) and `readChunk()` (text
      delta, reasoning field, finish reason, usage normalization from
      `prompt_tokens`/`completion_tokens`/`total_tokens`), the inline-`<think>`
      splitter (markers split across chunks, unclosed marker flushed,
      pass-through), Workers AI error mapping, SSE frame encoding, and
      `buildInferenceLogFields()` excluding content.
    - `src/client/vitest.config.ts` (`environment: jsdom`, `name: client`,
      `@vitejs/plugin-vue`): component and behavior tests with `@vue/test-utils`
      and `@pinia/testing` for the selector and its per-model parameter bounds
      (including re-clamping on model switch), transcript rendering, the
      Thinking panel appearing only for reasoning turns, the activity indicator
      lifecycle, Stop aborting, the stream reader fed a synthetic stream
      (including a chunk-split frame and a `401` JSON response), and the
      Markdown transcript builder.
    - `tests/integration/vitest.config.ts` (`name: integration`,
      `@cloudflare/vitest-pool-workers`, `configPath` resolved from
      `import.meta.dirname`, and **`remoteBindings: false`** with a comment
      explaining that the `ai` binding would otherwise force a credentialed
      remote proxy session).
23. Integration tests MUST cover the complete primary workflow and the access
    boundaries in real `workerd`, driving the Hono app with an injected fake
    `Ai` (see "Workers AI Has No Local Simulation"). The fake MUST return a
    `ReadableStream` of **SSE bytes**, exactly as `env.AI.run()` does, so the
    real decoder is exercised rather than bypassed, with one scripted byte
    sequence per adapter shape:
    - Unauthenticated requests are rejected on `POST /api/chat` and
      `GET /api/me`; `/api/chat` returns a status code, not an HTML redirect.
    - A valid request returns `text/event-stream` with `Cache-Control: no-store`
      and frames in order: `start`, deltas, `done`.
    - **Every adapter is covered end to end**: a `cf-native` script with inline
      `<think>` markers, a `cf-native` script with no reasoning at all, and an
      `openai-chat` script carrying `reasoning_content` — each producing the same
      normalized `thinking` and `answer` frames, and no literal `<think>` ever
      reaching an `answer` frame.
    - The model actually invoked equals the requested catalog model; the input
      built for it uses the adapter's correct token-limit field with an explicit
      value; parameters are clamped to that descriptor's range; and the messages
      passed upstream include the server-owned system prompt and exclude any
      client-supplied `system` message.
    - An unknown model, an empty conversation, a conversation not ending in a
      `user` turn, and an oversized body each return the expected RFC 9457
      status and body **before** any stream opens.
    - An upstream failure before the first token yields a `502` problem details
      response; a failure after the first token yields an `error` frame and a
      closed stream.
    - Cancelling the response stream cancels the upstream reader (assert the
      fake `Ai` observed the cancellation), proving a stopped generation stops
      billing.
    - `done` carries TTFT, total duration, and the usage the fake model
      reported, and `null` usage when it reports none.
    Configure `@vitest/coverage-istanbul` and a `test:coverage` script; treat
    uncovered authored source as a gap to close.
24. Provide single-command `npm run deploy` (Terraform init/apply, generate
    `wrangler.jsonc` + types with `generate-wrangler -cf --terraform infra`,
    `vite build`, `wrangler deploy`) and `npm run teardown` (`terraform destroy`
    plus the `postteardown` cleanup), composed from small `package.json` scripts
    chained with `run-s`. There is **no** `preteardown` step: Workers AI provisions
    nothing, so a successful destroy of the Worker, custom domain, and Access
    application leaves no named or billable resource behind. State that
    explicitly in the docs — the absence of cleanup is part of the lesson.
25. Write `README.md` (operator/developer guide: prerequisites, architecture, the
    stateless-Worker/browser-held-conversation split, the fully authenticated
    Access model and how to narrow it for cost control, the model catalog and
    **how to add a model — including when a new adapter is required**,
    environment configuration, the remote-`AI`-binding local
    development story and its credential requirement, testing including why the
    integration project disables remote bindings, observability, exact deployment
    steps, the manual per-model smoke check, Workers AI free-tier and neuron
    considerations, cold-start latency, troubleshooting, and exact teardown) and
    `DEMO.md` (presenter guide: what Workers AI is and is not, the nine-step flow
    above, what to say while the dots are bouncing, how to contrast a reasoning
    and a non-reasoning model, where to find the `ai_*` events in Workers Logs
    and the per-model metrics in the dashboard, and the "no content is logged"
    point). Add JSDoc to every authored TypeScript declaration describing
    implemented behavior.
26. Extend `.env.example` from the baseline with only what this demo needs:
    baseline permissions plus a **Workers AI** account permission (used by
    remote-binding local development; confirm the exact dashboard permission
    group and whether Read suffices, since deployment itself needs only
    `Workers Scripts : Edit`), `DEMO_DOMAIN`, `DEMO_NAME=ai-chat`, and
    `CLOUDFLARE_TEAM_DOMAIN`. No `ADMIN_EMAIL` is required. No runtime secret
    exists, so no Wrangler secret or secret binding is needed. Never commit real
    secrets or the generated local configuration.
27. Verify formatting, linting, type checking, all three Vitest projects, the
    production build, the generated Wrangler configuration, and
    `terraform fmt -check` / `terraform validate` in `infra`. Add
    `docs/DECISIONS.md` entries recording (a) the verified Workers AI
    local-development findings — remote-only binding, `.env` credential
    resolution, `.dev.vars` interaction, `remoteBindings: false` in the
    integration pool, and the inject-a-fake-`Ai` test pattern — and (b) the
    model-shape findings: `env.AI.run(..., { stream: true })` yields raw SSE
    bytes, the Workers AI catalog spans at least two request/response schemas,
    and the adapter registry is how this repo absorbs that. Demos 6 and 7 build
    directly on both, so neither should be rediscovered. Do not run
    `terraform apply`, deploy, or destroy real resources unless the operator
    explicitly requests it and provides the environment.

### Note — the Worker owns the stream contract, not the model

The tempting shortcut is one line: `return new Response(await env.AI.run(model,
{ messages, stream: true }), { headers: { "content-type": "text/event-stream" }})`.
It appears to work, and it destroys the demo. Piping the provider's stream
straight through means the browser has to parse whichever shape the current model
emits, reasoning markers arrive as literal `<think>` text in the visible answer,
there is no point at which the Worker can measure time-to-first-token or read the
final usage figures — so the "log latency and token usage" lesson has nowhere to
live — and a cancelled request keeps generating upstream. Owning the protocol
also means demo 6 can put AI Gateway behind the same `/api/chat` contract without
touching the browser code.

The second tempting shortcut is buffering: awaiting the whole generation, then
returning it. That yields a page that hangs for ten seconds and then blinks a
finished answer into place, which is the exact opposite of what this demo is
supposed to show. Write each delta out as it arrives, keep only counts in
memory, and let the browser render progressively.
