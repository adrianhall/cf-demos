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
6. Create Video
7. Animate Image
8. Generate Music
9. Read Text
10. Transcribe Audio
11. Translate Text
12. Classify Text
13. Evaluate Choices
14. Semantic Search
15. View Tokens

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
