# Playground — Engineering Specification

## 1. Implementation decision

Build the first implementation at **`cf-terraform-demos/playground`** using **Vue 3, TypeScript, Vite, Hono, Cloudflare Workers, AI Gateway, Workers AI, and Terraform**.

A future `vinext-demos/playground` may reuse the API and domain contracts described here, but it is not part of the initial delivery.

### Why `cf-terraform-demos` + Vue first

| Requirement | Decision rationale |
| --- | --- |
| AI Gateway is mandatory | Terraform can create, configure, and destroy the named gateway alongside the Worker, custom hostname, and Access controls. It makes the gateway a visible, repeatable part of the demo rather than an account-side prerequisite. |
| One Worker, many task-oriented APIs | Hono on a Cloudflare Worker gives the API tier a small, explicit surface while Workers AI stays behind a server-side binding. |
| Rich, highly interactive panels | Vue 3 Composition API is well suited to the token visualization, media previews, polling states, session ledger, typed forms, and progressively added feature panels. |
| Repository conventions | When no framework has a clear product advantage, repository guidance says to prefer `cf-terraform` + Vue. It also provides the complete ownership/lifecycle pattern required for a deployable reference demo. |
| Teaching infrastructure lifecycle | Terraform provisions the gateway, Worker registration, hostname, and Access resources; `cf`/Vite builds and uploads Worker code. `pnpm deploy` and `pnpm teardown` can therefore leave the account clean. |

The browser never receives Cloudflare credentials or calls Workers AI, AI Gateway, or a third-party model directly.

## 2. Product boundary

Playground is one authenticated, web-based application for experimenting with AI model task types. It has a **flat, one-level navigation** of plainly named panels:

1. Chat
2. Create Image
3. Describe Image
4. Remix Image
5. Classify Image
6. Detect Objects
7. Create Video
8. Animate Image
9. Generate Music
10. Read Text
11. Transcribe Audio
12. Translate Text
13. Classify Text
14. Evaluate Choices
15. Semantic Search
16. View Tokens

The technical task type is shown as a subtitle and in request details. Visual group headings are permitted in the sidebar, but are labels only: not routes, controls, or nested navigation.

The product has two kinds of panel:

- **Inference panels** invoke a model and must use AI Gateway unless an explicit, documented platform limitation makes that impossible.
- **View Tokens** does not invoke a model. It tokenizes locally and is not an AI Gateway exception because no inference takes place.

## 3. Mandatory AI Gateway policy

### 3.1 Invariant

Every inference request routes through the provisioned AI Gateway. This is a code and infrastructure invariant, not a UI choice, environment switch, or best-effort fallback.

All calls use the Workers AI binding form:

```ts
await env.AI.run(model, input, {
  gateway: {
    id: gatewayId,
    collectLog: true,
    metadata: {
      task: taskId,
      requestId,
      authenticatedUserEmail: identity.email,
    },
  },
});
```

The production code must obtain `gatewayId` from the typed application configuration backed by Terraform output. It must never use the implicit `default` gateway in a deployed environment.

### 3.2 Central gateway client

Only `src/worker/infrastructure/ai/gateway-inference-client.ts` may reference `env.AI.run`, `env.AI.aiGatewayLogId`, or `env.AI.gateway()`. It implements the domain-facing `InferencePort` and owns:

1. building the mandatory gateway options;
2. adding required metadata (`task`, opaque `requestId`, verified authenticated-user email, model descriptor version);
3. dispatching inference;
4. capturing the post-call AI Gateway log ID;
5. retrieving gateway log details and normalising latency, cache, usage, and cost;
6. mapping platform failures to application errors without exposing provider error internals.

Feature services receive `InferencePort` through constructor injection. A route handler must not construct an inference client or call `env.AI`.

A static test must fail if another production module references `env.AI.run`. A unit test must assert that every inference invocation supplies a non-empty gateway ID and `collectLog: true`.

### 3.3 Exceptions register

Create and commit **`cf-terraform-demos/playground/AI-GATEWAY-EXCEPTIONS.md`** from the first phase. Before an exception exists, it contains an explicit empty register.

The application owns `src/worker/domain/gateway-exceptions.ts`, a typed list of non-gateway **inference** paths. The document is generated or checked against that list. Each exception has:

- stable ID;
- panel and API route;
- model/provider and affected operation;
- exact technical reason gateway routing is impossible;
- loss of gateway observability/cost data;
- user-facing fallback behaviour;
- product-gap tracking link or a statement that none is warranted.

A `NO_AI_GATEWAY: <exception-id>` annotation at the actual call site is required. `pnpm check` verifies that code annotations, typed entries, and document entries match exactly. Empty is expected initially; silent direct inference is a defect.

`View Tokens` is explicitly excluded: it is local computation, not an inference exception.

## 4. Cost, telemetry, and request lifecycle

### 4.1 A run is a first-class client concept

A **run** is one user action and may contain one or several gateway inference calls. It has an opaque browser-generated UUID, one panel/task ID, timestamps, state, result reference, and zero or more gateway request records. Examples:

- Chat normally has one inference request.
- Semantic Search may embed the query and several previously uncached passages; it has several inference requests and an aggregate cost.
- View Tokens creates no run and never changes the session cost ledger.

The browser maintains the current session’s run history and ledger in memory, optionally persisted in `sessionStorage` after sanitising out media, prompt text, and model output. Server persistence is out of scope.

### 4.2 Response and status protocol

Every completed or accepted inference response returns a `RunReceipt` containing:

- `runId`, `task`, `model`, and `gatewayRouted: true`;
- one or more safe gateway log IDs;
- result or job descriptor;
- request status and timing known at completion;
- a `costStatus` of `pending`, `available`, `unavailable`, or `not-applicable`.

The inference response is never delayed waiting for AI Gateway logs. The UI then calls:

```text
GET /api/runs/:runId/metrics
```

The server resolves each saved log ID using `env.AI.gateway(gatewayId).getLog(logId)`. It makes a small bounded retry when the log has not propagated, returns `pending` with a retry hint when appropriate, and eventually returns `unavailable` rather than fabricated zero cost. The endpoint authorizes the requester before returning a receipt: a run belongs to the authenticated session that created it.

For streamed Chat responses, send the completion over SSE and include `runId`/log ID in the final event. The browser starts metrics polling only after that event. Do not attempt to call `getLog()` until the inference stream has settled.

### 4.3 Cost presentation

The UI has:

- **Per-run details**: model, provider class, gateway name, log ID, elapsed time, cache status, available usage, reported cost, and pricing unit.
- **Persistent session meter**: total known cost, a distinct “pending/unavailable” count, grouped totals by panel and model, and cache hits versus billed requests.
- **Comparison/history**: output, latency, cache state, and cost side-by-side.
- **Activity / Gateway page**: a privacy-safe summary of the current browser session and a link to the corresponding AI Gateway dashboard.

Cost values come only from AI Gateway logs. The UI never calculates a price from token counts itself. A model descriptor may provide its pricing **unit** for labelling (`token`, `audio-second`, `track`, `video-output`, or `provider-reported`) but not an estimated price.

Missing cost remains missing. Show `Pending`, `Unavailable`, or `Not applicable`; never replace it with `$0.00`.

### 4.4 Privacy

Gateway logs are useful for cost, usage, status, and timing even when raw payload storage is disabled. Configure the gateway and requests for metadata-only payload collection unless a later specification explicitly justifies saved payloads.

Metadata includes the task ID, opaque run ID, **verified authenticated-user email**, descriptor version, and a non-identifying cache category. The email comes only from the Access middleware's verified identity (`currentIdentityEmail()`), never from a request header, body, or browser-provided value. This demo deliberately records it so AI Gateway logs and analytics can be attributed to the signed-in user; users must be told this before they submit a request. Metadata never contains a prompt, uploaded media, transcript, generated output, or a raw file name.

Worker structured logs similarly record request IDs, task/model IDs, duration, outcome, and error category only. They must not record prompts, content, tokens, media URLs, Gateway log payloads, or the authenticated email; the email belongs in AI Gateway metadata only.

## 5. Architecture

### 5.1 Four tiers

Dependencies point in one direction:

```text
Vue UI → Hono API → application/domain → infrastructure
```

| Tier | Responsibility | Must not do |
| --- | --- | --- |
| UI | routing, input validation feedback, task forms, media rendering, session cost ledger, token visualization | call a Cloudflare/model API or trust itself for authorization/cost |
| API | Hono routes, Access middleware, body/file limits, content-type checks, SSE, response shaping, rate limits | contain model-specific business logic or instantiate repositories |
| Application/domain | model descriptors, task validation, use cases, `RunReceipt`, cost normalisation, exception policy, ports | import Hono, Vue, `env`, or concrete Cloudflare bindings |
| Infrastructure | AI Gateway-backed inference client, AI Gateway metrics client, media/job adapter, in-memory session/run repository, configuration | decide UI behaviour or task eligibility |

### 5.2 Suggested layout

Follow the established `cf-terraform-demos` convention: the Worker entry point is `src/worker/index.ts`, and every server-side tier it composes lives below `src/worker/`. The Worker is both the Cloudflare runtime entry point and the application’s HTTP/API host, so keeping Hono middleware, routes, use cases, domain contracts, and Cloudflare adapters together makes the execution boundary immediately obvious. It also prevents browser code from accidentally importing Worker-only bindings.

This does **not** collapse the four tiers. `src/worker/index.ts` is the composition root: it reads bindings, constructs infrastructure adapters, injects them into application services, and mounts middleware and routes. The `routes`, `application`, `domain`, and `infrastructure` directories remain separate, with their one-way dependency direction unchanged; `middleware` is a sibling cross-cutting concern shared by the route layer. The Worker entry point is allowed to depend on every server-side tier precisely because composition is its single responsibility; no other tier receives that exception. The HTTP/API tier is the architectural concept, while `routes` is the repository-consistent directory name for its thin Hono handlers.

```text
cf-terraform-demos/playground/
├── src/
│   ├── client/
│   │   ├── app/
│   │   ├── router/
│   │   ├── components/
│   │   │   ├── shell/
│   │   │   ├── runs/
│   │   │   └── panels/
│   │   ├── composables/
│   │   ├── features/
│   │   │   ├── chat/
│   │   │   ├── create-image/
│   │   │   ├── …
│   │   │   └── view-tokens/
│   │   └── services/playground-api.ts
│   └── worker/
│       ├── index.ts                    # Worker entry point and composition root
│       ├── routes/                     # Thin HTTP/SSE route handlers
│       ├── middleware/                 # Access, limits, errors, rate limits
│       ├── application/
│       │   ├── ports/
│       │   ├── runs/
│       │   ├── tasks/
│       │   └── metrics/
│       ├── domain/
│       │   ├── models.ts
│       │   ├── tasks.ts
│       │   ├── runs.ts
│       │   ├── problems.ts
│       │   └── gateway-exceptions.ts
│       └── infrastructure/
│           ├── ai/gateway-inference-client.ts
│           ├── ai/gateway-metrics-client.ts
│           ├── runs/session-run-repository.ts
│           ├── tokenizers/
│           └── config.ts
├── tests/
│   ├── client/
│   ├── worker/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── application/
│   │   ├── domain/
│   │   └── infrastructure/
│   └── integration/
├── infra/
├── cloudflare.config.ts
├── access.config.ts
├── AI-GATEWAY-EXCEPTIONS.md
└── README.md
```

The exact feature filenames may vary, but the `src/worker/` boundary, `routes`/`middleware` convention, and tier dependencies may not.

### 5.3 Vue composition

Use Vue 3 Composition API with `<script setup lang="ts">`. Route views are composition surfaces, not feature implementations. Each feature owns focused presentational components and one stateful composable; shared state lives in a small app-level composable rather than a global store until a real cross-feature need proves otherwise.

Minimum shared UI components:

- `AppShell` — navigation, current identity, session cost meter, activity link.
- `PanelPage` — consistent title, technical task type, model selector area, request-details affordance.
- `RunControls` — disabled/running/cancellable state, example/reset actions.
- `RunDetails` — accessible disclosure for gateway ID, log ID, timing, usage, cache, and cost.
- `RunHistory` — local comparison and session ledger.
- `GatewayStatusBadge` — always says `Routed through AI Gateway` for inference; only typed documented exceptions can render its alternate form.

Panel components receive typed props and emit events. They do not import the API client directly. Feature composables own API calls, cancellation, local validation state, and run-status transitions.

#### 5.3.1 Activity-first panel UX for phases 6+

The remaining panels must extend the interaction language established by **Create Image** and
**Describe Image**, rather than introducing a new layout for every modality. A new panel is not
complete when its API works; it is complete when a first-time visitor can identify the input, run the
model, understand the output state, and inspect the run without leaving the activity surface.

Use these rules for **Remix Image, Classify Image, Create Video, Animate Image, Generate Music, Read
Text, Transcribe Audio, Translate Text, Classify Text, Evaluate Choices, and Semantic Search**:

- **Activity before explanation.** The panel's primary surface starts with the task input and its
  result workspace. Put technical explanation, model documentation, privacy disclosure, limits, and
  trade-off discussion behind the shared header information button/About dialog. The header still
  identifies the panel and its technical task type, but the main flow must not be displaced by a
  large essay.
- **Use the shared panel framing.** Build the route with `PanelPage`, the shared title/About
  affordance, `GatewayStatusBadge`, and the shared run-details presentation. Do not add a second
  page heading, a nested card containing another copy of the panel title, or a bespoke diagnostics
  drawer. Chat is the intentional exception: it keeps its conversation layout while using the same
  title/About and run-details patterns.
- **Make input and output a `PanelWorkspace`.** Before the first result, centre the input workspace
  so the visitor has one obvious next action. Once a result, accepted job, or structured answer
  exists, place input and output side by side on a wide screen and stack them on a narrow screen.
  The output must remain visible while the visitor adjusts or reruns the input. For text-only or
  ranking tasks, use the same principle with an input column and result column rather than forcing a
  media card.
- **Keep controls close to the action.** The primary run button follows the input and is disabled
  during invalid or incomplete input. Example prompts/files appear immediately below the relevant
  prompt or input and above Run/Generate. Reset and cancellation are task-level controls, not
  competing primary actions. Use native `details`/`summary` for secondary model parameters and
  keep that section collapsed by default while showing the selected model name.
- **Treat output as activity, not a gallery of unrelated cards.** Show loading, streaming, polling,
  cancellation, failure, empty, and completed states in the output workspace. Render the result in
  the format the task teaches: image, video, audio, transcript, translated text, ranked labels,
  probabilities, vectors, or structured JSON. Do not make explanatory copy or a historical gallery
  the dominant content. If multiple outputs are returned, each result needs its own status and
  metadata, but the current run remains visually primary.
- **Put diagnostics behind an information control.** After a run is accepted or completed, expose
  Run Details from the activity surface with the same accessible information button used by the
  media panels. In a panel modal, use the embedded Run Details presentation: no redundant nested
  border, card, padding, or duplicate heading. Include the copyable Gateway log identifier, model,
  elapsed time, cache/usage data, reported cost, and honest pending/unavailable states. Do not make
  visitors open a separate page to understand the current run.
- **Use metadata as the download affordance for generated files.** A generated image, video, audio
  track, or transcript download should identify the format and use the result's File/metadata line
  as the link where that is the clearest action. Do not add a separate generic gallery note or a
  speculative cross-panel action merely to fill space. Handoffs between panels are optional, must be
  explicitly useful to the task, and must never replace Download, Run Details, or the primary result.
- **Keep media transient.** Preview generated media in the browser and do not add R2 or a retention
  promise just to support a result gallery. Validate returned URLs and label provider-hosted assets
  honestly. If an async provider requires persistence, introduce it as an explicit infrastructure
  decision with expiry, cleanup, tests, and teardown ordering.
- **Preserve accessible responsive behaviour.** Use real labels, keyboard-operable controls, visible
  focus, status announcements for asynchronous work, useful alternatives (`alt`, transcript,
  captions, or structured text), and mobile stacking. Do not rely on colour, hover, alignment, or a
  media preview alone to communicate state. Test the first-run state, post-result state, mobile
  layout, invalid input, cancellation, and the run-details dialog.

The implementation phase may share composables and presentational components across related tasks,
for example video job polling between Create Video and Animate Image, or ranked-result rendering
between Classify Image and Classify Text. Keep each panel as its own top-level route and feature
folder: share code, not tabs. Each new phase must add or update the panel's client tests, domain
validation tests, authorization/route tests, and Workers-runtime integration coverage before it is
considered delivered.

#### 5.3.2 Phase-specific panel shapes

The activity-first rules above apply to every phase, with these additional shapes and teaching goals.
They describe the starting point for implementation; the current model catalogue remains authoritative
for exact model IDs, limits, controls, response formats, and Gateway eligibility.

**Phases 9 onward are ordered by model hosting, not by product priority.** A Cloudflare-hosted model
needs no prepaid AI Gateway credits; a third-party one does. A panel whose only options are
third-party therefore cannot be built or demonstrated on an unfunded account, so every panel with a
hosted model comes first (phases 9–14), the credit-dependent panels follow (15–16), and the panel
with no usable model at all stays last (17). Each implementation phase records its candidate hosted
and third-party models and must re-confirm hosting before it starts, because the catalogue changes —
a panel may become credit-free, or stop being so, between phases.

| Phase | Panel | Start with | After the first run | Important implementation detail |
| --- | --- | --- | --- | --- |
| 6 | Remix Image | Validated reference image, a preservation-aware editing instruction, and only the selected model's supported seed control | Before/after image workspace with the source and current output clearly related | Default to Cloudflare-hosted FLUX.2 Klein 4B, with Klein 9B and Dev as hosted quality comparisons; offer P-Image-Edit and Nano Banana 2 as third-party comparisons. Use explicit per-model adapters, enforce FLUX's reference-size limit, retrieve provider-hosted output under a strict origin/size/signature policy, and never simulate whole-image editing with an inpainting mask. |
| 7 | Classify Image | Image input with a short example/paste affordance and model-specific top-k controls | Original image beside ranked labels, scores, and an expandable structured response | Use Cloudflare-hosted ResNet-50, whose schema accepts only the image: apply top-k and the confidence floor to the response, declare that in the descriptor, and say so in the UI rather than implying the model was asked to rank. Explain that scores are model output describing resemblance to training data, not factual certainty. Render labels as a table whose scores are text, with bars as `aria-hidden` decoration, so nothing depends on bar length or colour. |
| 8 | Create Video | Prompt, examples, model selector, and the smallest meaningful duration/aspect controls | Current video result with poster, progress/job status, duration, download, and Run Details | Treat generation as potentially asynchronous from the start. Use the task-neutral `MediaJob` contract, bounded polling, cancellation, and honest failed/expired states. |
| 9 | Read Text | Text input, examples, voice/language controls, and only supported rate/pitch controls | Current audio player with duration, transcript/text alternative, download, and status | Preserve the source text as an accessible alternative. Treat audio as transient binary/provider output rather than a text card with a play button added later. |
| 10 | Transcribe Audio | Upload or microphone input with explicit permission, format/size/duration limits, and language hint | Transcript first, with copy/download, timestamps, confidence where available, and audio context | Make recording, upload, processing, cancellation, and failure states distinct. Never expose raw media or transcript in logs or Gateway metadata. |
| 11 | Translate Text | Source text, source/target language selectors, examples, and a swap action | Source and translated text columns, stacked on mobile, with copy/download | Preserve line breaks and make the target language/result obvious. A Read Text handoff is optional secondary functionality, not part of the primary run path. |
| 12 | Classify Text | Text input, prepared examples, and a reviewed fixed label/task mode | Ranked label/confidence result with an expandable structured response | Keep this visibly different from Evaluate Choices: fixed model labels here, not caller-defined questions. Do not render arbitrary model prose as the result. |
| 13 | Semantic Search | Query plus a small editable example collection and embedding model selector | Ranked passages with relative similarity, collection/query cache state, and an expandable vector summary | A search run may contain multiple inference calls. Show aggregate cost and individual Gateway records; similarity is not probability or factual confidence. |
| 14 | Evaluate Choices | State editor plus a typed question builder; show the selected model and context usage | Per-question typed visualizations plus inspectable JSON, with answer and confidence separate | Validate the question schema in the domain layer. Do not ask a general chat model for JSON or parse prose; the typed Jev/Clef contract is the feature. |
| 15 | Generate Music | Style/mood prompt, instrumental/lyrics controls, and supported duration/format controls | One current audio track with player, duration, lyrics/transcript when applicable, download, and status | Teach non-token billing with the declared track/audio-second unit. Provider-hosted URLs are untrusted and may expire; do not promise retention. |
| 16 | Animate Image | Source image, optional motion instruction, and supported duration/resolution controls | Source still beside the current video result and its job status | Share job polling and video rendering with Create Video, but keep a separate route and task copy. A useful Create Image-to-Animate handoff may be offered only as a secondary action. |
| 17 | Detect Objects | **Blocked: no model.** Image input with the shared picker and a model-specific score floor | Source image with labelled boxes overlaid, beside the same ranked table Classify Image uses | Answers *where*, not *what*. Validate every box's geometry before rendering it and clamp it to the image. The overlay is an enhancement: the table and its described regions must be a complete result on their own. Link a row and its box in both directions on hover and focus. |

For phases 6–17, do not add a new shell, navigation level, or panel-specific interpretation of session
cost. A phase is allowed to introduce a new result renderer or a task-specific input control, but it
must reuse the existing shell, About dialog, `PanelWorkspace`, model-settings pattern, Run Details
modal, session ledger, error format, and Access posture. If the selected provider cannot satisfy the
shape through the shared Worker contract, stop and document the contract or Gateway exception before
building a UI workaround.

### 5.4 Model catalogue and task descriptors

Use committed, typed model descriptors in `src/worker/domain/models.ts`. They are a reviewed subset of the live unified catalog, not a runtime scrape. Each descriptor includes:

- stable ID, display name, provider classification (`workers-ai` or `third-party`);
- exactly one task ID;
- input/output contract version;
- context/input limits and supported UI controls;
- pricing unit label;
- whether the operation is synchronous, streamed, or job-based;
- documentation URL;
- gateway eligibility (normally `required`; an exception requires an exception ID).

The current catalog is the source of truth when adding or updating descriptors. A descriptor validation test confirms that each panel’s controls map to only declared model capabilities.

### 5.5 Media handling

The Worker accepts media through task-specific HTTP routes only. Validate declared content type, byte length, extension-independent file signature where feasible, and image/audio duration or dimensions when the model needs limits. Apply `jsonBodyLimit()` before parsing JSON and use `readJsonBody()` from `@demos/worker-common`.

Initial scope keeps media transient:

- Send a validated upload to the model within the request when its supported input permits it.
- Do not persist user uploads or generated media in R2 merely to make a panel work.
- Render provider-returned media URLs only after validating allowed schemes/hosts and treating them as untrusted external URLs.
- If a model requires async callback/job storage that cannot safely be held in a request, add R2 in a later phase with Terraform ownership, expiry/lifecycle policy, content cleanup, and teardown ordering. That change must be explicitly designed rather than slipped in.

### 5.6 Long-running jobs

Create Video, Animate Image, and Generate Music may be asynchronous. Model adapters return a task-neutral `MediaJob` (`accepted`, `running`, `completed`, `failed`, `cancelled`) rather than leaking provider response shapes into routes.

The browser polls a task-specific, authenticated status route with bounded exponential backoff and a visible cancellation affordance. Do not use a Durable Object or Workflow in the first implementation unless a selected provider requires a callback or execution duration that exceeds a Worker request. If either becomes necessary, document the platform constraint, add its lifecycle resources, and keep the route/API contract unchanged.

## 6. API surface

All API routes live under `/api`, receive Cloudflare Access middleware, validate the Access JWT and intended audience, and derive actor identity only from `currentIdentity()`/`currentIdentityEmail()`.

Every error is RFC 9457 `application/problem+json`. Use shared worker-common problem helpers; never expose provider stack traces.

| Route | Purpose |
| --- | --- |
| `GET /api/me` | Verified identity for the shell via `createMeRouter()`. |
| `GET /api/catalogue` | Safe model/task descriptor data; no credentials or provider keys. |
| `POST /api/tasks/:task/runs` | Validates task-specific request, starts synchronous inference or accepts a media job, and returns `RunReceipt`. Chat may use a task-specific SSE route instead. |
| `GET /api/runs/:runId` | Retrieves a caller-owned run’s state/result metadata. |
| `GET /api/runs/:runId/metrics` | Retrieves resolved or pending gateway log metrics and aggregate cost. |
| `POST /api/runs/:runId/cancel` | Best-effort cancellation when model/provider supports it. |
| `GET /api/jobs/:jobId` | Caller-owned task-neutral media-job status. Only introduced with the first async capability. |
| `POST /api/chat/stream` | SSE-only Chat route; emits typed start/delta/completed/problem events. |

The API does not expose a generic `{ model, input }` passthrough. Each task has a narrow request schema and application use case; model selection is constrained to descriptors valid for that task.

## 7. Infrastructure, access, and configuration

### 7.1 Terraform ownership

Terraform owns:

- Worker registration and bootstrap deployment;
- custom hostname/DNS resources required by the demo;
- Cloudflare Access application(s) and policies;
- the named `cloudflare_ai_gateway`;
- any later dedicated resource strictly needed by the Worker (for example R2 only if async media requires it).

`cf` owns Worker build, upload, and deploy-time binding configuration. Terraform does not upload Worker application code.

Use `infra/providers.tf`, `infra/access.tf`, `infra/playground.tf`, and `infra/outputs.tf`; split further by resource concern only when required. Read repository-root `.env` with the dotenv Terraform provider. Every output is scalar and documented.

The gateway must set explicit values for logging, zero-data-retention, Logpush, cache, and rate-limit fields to avoid provider/API drift. It collects log metadata but does not retain request/response payloads unless a future privacy review changes the documented setting.

### 7.2 Access

The application is protected with Cloudflare Access. Anyone who can authenticate through the configured identity provider may use the demo; there is no application-level allowlist. The full app and `/api/*` use the same authenticated Access posture, and the Worker validates token signature, audience, expiry, and the intended Access application as defense in depth. Every inference request derives the authenticated user's email from that verified identity and records it in AI Gateway metadata.

Local development uses the Cloudflare Access Vite plugin and committed local audience placeholders. Development tokens are compile-time disabled in production.

### 7.3 Configuration

`cloudflare.config.ts` is the single typed Worker configuration source. It obtains production IDs — including `AI_GATEWAY_ID` and `ACCESS_AUD` — from ignored `infra/outputs.json` using `requireTerraformOutputs`; local development uses committed `infra/local-outputs.json` placeholders.

Generate `.cloudflare/types/index.d.ts` using `cf workers types --mode development`. Include it in TypeScript compilation; do not hand-write binding types.

## 8. Quality, accessibility, and security requirements

- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch`.
- Complete JSDoc on every exported function, class, public method, interface member, and non-trivial helper, including parameters, return outcomes, and meaningful failures.
- Every panel works by keyboard. Forms have visible labels and errors, async state uses accessible status messaging, and all controls meet target size/contrast requirements.
- Media has alternatives: image alt/description, audio transcript where available, and text/video download labels that identify format.
- The token visualisation does not communicate boundaries through colour alone and keeps original text selectable.
- Use `AbortController` for cancellable browser requests; discard late responses that no longer match the active run.
- Per-task server limits are explicit. Reject unsupported model controls, unknown task/model combinations, overlong text, oversized media, malformed JSON, and private-network/unsafe source URLs with problem details.
- Avoid SSRF: if image URLs are ever accepted, allow HTTPS only, resolve/inspect safely, block private/link-local ranges, cap redirects and bytes, or prefer upload-only input.
- Do not make the model catalogue an arbitrary-provider proxy. The server accepts only reviewed descriptors and task schemas.

## 9. Scripts and definition of done

`package.json` implements repository-required scripts using `npm-run-all2` and individually runnable colon sub-scripts:

- `pnpm start` — generates local types/config as needed and runs `cf dev --persist-to .cloudflare/state`.
- `pnpm check` — no writes; runs generated-type freshness verification, TypeScript, `oxfmt --check .`, type-aware Oxlint, `terraform fmt -check`, `terraform validate`, descriptor/exception-register validation, and relevant contract checks.
- `pnpm fix` — generates configuration/types, Oxfmt write, and safe lint fixes.
- `pnpm test` — domain, Worker, client DOM, and Workers-runtime integration projects.
- `pnpm deploy` — Terraform apply and outputs first, then Vite build and `cf deploy --prebuilt`.
- `pnpm teardown` — `cf workers delete` first, then any media-resource cleanup, then Terraform destroy.

Every integration test project sets a finite timeout. Tests run offline: unit/client/integration suites mock the gateway client at its port boundary. A separately named opt-in manual smoke check may use a real account, but must never be part of `pnpm test` or `pnpm check`.

The root README documents prerequisites, required token scopes, gateway/Unified Billing prerequisites, local Access identities, each command, cost/retention behaviour, the mandatory-gateway invariant, and the exception register.
