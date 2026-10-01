# Playground — Phased Implementation Plan

## Delivery rules

- The initial implementation lives at **`cf-terraform-demos/playground`** and follows [`01-specification.md`](./01-specification.md).
- Each phase is a shippable, passing repository state. Do not begin the next phase with broken tests, unchecked generated types, unformatted files, or known exception-register drift.
- Every inference panel must be gateway-routed from its first commit. Never add a direct `env.AI.run()` call as a temporary shortcut.
- The entire application is authenticated from the first phase. Anyone who can authenticate through the configured Access identity provider may use it; there is no application-level email allowlist.
- Every inference request derives the user email from the verified Access identity and includes it in AI Gateway metadata. The email must never come from a browser value, request header, or request body.
- Each phase adds tests at the lowest suitable tier: domain validation/use-case tests, Worker route tests, Vue DOM tests, and Workers-runtime integration tests for the public surface and authorization outcomes.
- Every phase must leave its failures diagnosable from logs alone. See [Cross-phase observability requirements](#cross-phase-observability-requirements); a phase whose panel can fail with nothing but a status code is not complete.
- `pnpm check` and `pnpm test` pass at the end of **every** phase. Tests remain offline; no phase adds a live-inference dependency to normal tests.
- Add a model only after confirming its current input/output contract in the unified model catalog. Pin that reviewed contract in the typed model descriptor and test it.

## Cross-phase acceptance command set

The final step of every phase runs:

```sh
pnpm check
pnpm test
```

`pnpm check` must stay read-only and includes TypeScript, Oxfmt check, type-aware Oxlint, generated type freshness, Terraform format/validation, descriptor validation, and AI Gateway exception-register consistency. `pnpm test` includes domain, Worker, client, and Workers-runtime integration suites as applicable to the completed phase.

A phase may add focused commands such as `pnpm test -- --project client`, but those are diagnostic aids, not substitutes for the full commands above.

## Cross-phase observability requirements

These apply to **every** phase that adds an inference panel, a job, or any other operation that can fail. They exist because of a concrete incident in Phase 4: a deployed Create Image request failed with a `502`, and the logs could not say why, which request it was, or whether the provider had even been reached. The central inference client had caught the provider's error with a bare `catch {}` and thrown a sanitised one, discarding the only description of the fault. The fault itself turned out to be transient — but it was undiagnosable, and that was the real defect.

The rules below are the generalisation of that fix. A panel is not finished when it works; it is finished when its failure can be understood by someone reading the logs a week later.

### Correlation

- Every operation carries the browser-generated **run ID** through every log line it produces, in the Worker and in AI Gateway metadata alike. One search on a run ID must return the whole story of that request.
- Where a gateway log ID exists, record it. It is the only thread between a Worker log line and the AI Gateway dashboard entry, and **its absence is itself a finding**: the request never reached the gateway.
- Two requests that look identical in an access log must be distinguishable in the structured logs by their run ID and their parameters.

### Log an attempt before it can fail

- Write a `<task>_run_started` line **before** calling the model, not only on completion. A request that fails inside the provider, times out, or is cancelled mid-flight must still leave a record of what it attempted — that is precisely the case where the parameters matter most.
- Record the **shape** of the request: the model, the contract version, the exact parameter names sent, and the values of bounded controls (steps, dimensions, guidance, seed, temperature). The most common integration failure is sending a model a parameter its schema does not accept, and a list of the keys that actually went on the wire diagnoses it in one line.
- Record text and binary inputs as **lengths or byte counts**, never content. "48 characters" distinguishes a real request from an empty one without retaining the visitor's prompt.

### Never discard a cause

- A `try` around a provider call must bind its error (`catch (cause)`) and log it. Sanitising the message for the browser is required; discarding it is a defect. Both are needed, and neither substitutes for the other.
- Log the error's type, message, and one level of wrapped `cause`. Coerce an unknown thrown value readably — `String(someObject)` yields `[object Object]`, which occupies a log line while saying nothing.
- Distinguish **our** refusal from **their** failure. When validation rejects a provider's output, say so with a reason code and a description of what arrived; a rejected payload and an upstream error are both a `502` to the browser but have entirely different fixes.
- An expected-empty result still deserves a line when it may indicate a fault. A gateway log that has not propagated is routine, but a permanently unresolvable one is the cause of a run stuck forever at "cost pending".

### What must never be logged

- No prompt text, generated media, transcript, model output, or raw file name.
- **Not the verified email.** It belongs in AI Gateway metadata only, which is a different retention domain with different access control.
- A new panel's log lines must be checked against both rules, and the check belongs in that phase's tests rather than in review.

### Tests each phase must include

- Assertions that a provider failure logs the provider's own message, the run ID, the model, and the parameter names.
- Assertions that no log line contains the prompt or the verified email — written as "must not contain", since that is the direction that silently rots.
- An architecture guard that fails the build if a `try` wrapping a provider call swallows its cause, and if the composition root stops supplying a logger to a client or service that needs one.

### Deployment reality check

Offline tests cannot prove observability is wired correctly, because a test double never produces the error a real provider does. Each phase's exit criteria therefore include **one real deployed request per new panel**, confirming that a success and an induced failure both produce the expected correlated log lines. A panel whose logging has only ever been exercised against a fake is unverified.

---

## Phase 1 — Deployable shell and control-plane foundation

### Goal

Create the deployable application shell, Terraform lifecycle, authenticated Worker API, model/task catalogue, mandatory AI Gateway foundation, and test harness. The product is not yet useful as an AI playground; View Tokens in Phase 2 is the first usable capability.

### Deliverables

1. Create `cf-terraform-demos/playground` as a pnpm workspace package.
2. Configure Vue 3, Vite, TypeScript, Hono, the Cloudflare Vite plugin/`cf` CLI workflow, Vitest, Vue Test Utils, Workers runtime testing, Oxfmt, and type-aware Oxlint in line with sibling demo conventions.
3. Add `cloudflare.config.ts`, committed `infra/local-outputs.json`, type generation, and `.cloudflare` ignore rules.
4. Add Terraform:
   - `providers.tf` sourcing only the repository-root `.env`;
   - `playground.tf` registering the Worker, stable bootstrap version/deployment, hostname, and `cloudflare_ai_gateway`;
   - `access.tf` for the Access application/policy;
   - `outputs.tf` exposing documented scalar worker/gateway/audience values.
5. Configure AI Gateway deliberately: named gateway ID, metadata logging, no raw payload retention by default, explicit cache/rate limit/log-management fields, and no implicit `default` gateway. The metadata contract must include the verified authenticated user's email for every inference request.
6. Implement Access locally and in production with `@demos/worker-common`:
   - shared policy builder;
   - `createAccessMiddleware` in Hono;
   - `cloudflareAccessPlugin` for local development;
   - `GET /api/me` through `createMeRouter()`;
   - `GET /api/catalogue` returning public typed descriptors.
7. Implement an app shell with:
   - flat sidebar containing all 15 panel names, including panels not delivered yet;
   - non-interactive visual group labels only;
   - direct routes for every panel;
   - a route-level “Coming in a later phase” placeholder for unavailable panels;
   - current verified identity and Sign out control;
   - a session cost meter in an empty, explicit `No inference runs yet` state;
   - Activity / Gateway screen and privacy-safe gateway explanation.
8. Create all shared contracts: `TaskId`, `ModelDescriptor`, `RunReceipt`, `GatewayRequestMetric`, `SessionCostLedger`, `InferencePort`, `RunRepositoryPort`, `GatewayException`, and RFC 9457 application errors.
9. Implement the central `src/worker/infrastructure/ai/gateway-inference-client.ts` skeleton and its test double. Its signature requires a verified identity, so a caller cannot build an inference request without one. No feature invokes it yet.
10. Commit `AI-GATEWAY-EXCEPTIONS.md` stating that the register is empty; add a typed empty exception list and a consistency-check script.
11. Add baseline README sections: prerequisites, local workflow, deployment/teardown, gateway policy, privacy/cost policy, and a table marking all panels as planned except View Tokens in the next phase.

### Tests introduced

- **Domain:** task/model descriptor integrity; every panel has a unique route and descriptor; all inference task descriptors declare `gateway: required`; View Tokens declares `noInference`.
- **Infrastructure/config:** parsed Terraform/config assertions for named AI Gateway output, Access audience output, and matching binding/config names.
- **Worker unit:** `/api/me` Access success/failure; `/api/catalogue` does not disclose secrets; unknown `/api` routes are problem details. Keep the handlers in `src/worker/routes/` and shared middleware in `src/worker/middleware/`, matching the other `cf-terraform-demos`.
- **Client DOM:** all sidebar destinations render; group headings are not controls; navigating changes the route; placeholders are accessible; cost meter starts empty.
- **Architecture guard:** only the central gateway client may import/reference `env.AI.run`; no exception annotations exist while the register is empty.
- **Gateway metadata contract:** the metadata builder always emits task, opaque run ID, and the verified email; it rejects a missing identity rather than sending an anonymous request, and it ignores any email supplied in a header or body.
- **Workers runtime integration:** unauthenticated request denied, valid local Access identity accepted from more than one test identity, intended audience enforced, and `/api/catalogue` has the expected safe shape. Set a finite project timeout.

### Exit criteria

- `pnpm start` shows the authenticated, responsive shell with all flat panel destinations.
- Any identity the configured provider accepts can sign in, and the shell shows that verified identity.
- `pnpm deploy` provisions the named gateway and protected Worker; `pnpm teardown` deletes Worker code before Terraform destroys infrastructure.
- `pnpm check` and `pnpm test` pass.

---

## Phase 2 — View Tokens (first usable panel)

### Goal

Deliver **View Tokens**, the first fully usable Playground capability. It performs local tokenization only: no model inference, gateway log, or cost is created.

### Deliverables

1. Add an in-browser tokenizer adapter with a narrow `TokenizerPort`, lazy-loaded to avoid taxing the initial shell bundle.
2. Define supported tokenizer descriptors and their relationship to panel model descriptors. Clearly mark estimates where an exact tokenizer is unavailable.
3. Implement the View Tokens feature as focused components:
   - prompt input and prepared examples;
   - tokenizer selector;
   - coloured token sequence;
   - live token/character/ratio summary;
   - optional context-window proportion;
   - token table with index, escaped text, and ID;
   - visible-whitespace and special-token toggles.
4. Preserve selectable original text. Token boundaries use spacing/outline as well as colour, and each token receives an accessible label.
5. Add a safe long-input policy: debounce typing, cap/virtualize token box rendering, and show a clear truncation notice.
6. State in the panel and documentation that tokenization is local computation, not inference; it contributes neither a run nor cost.
7. Add the first actual “usable now” status to the README and Overview.

### Tests introduced

- **Domain/unit:** tokenizer normalization, exact reconstruction of original input, whitespace/newline rendering, special-token handling, count/context calculations, and tokenizer-approximation labels.
- **Client DOM:** debounced token rendering; keyboard focus/accessible labels; toggles; prepared examples; text selection-friendly markup; long-input notice; no network request for typing.
- **Worker:** no inference route is added; a regression test confirms View Tokens is absent from gateway task dispatch.
- **Architecture:** View Tokens does not create a `RunReceipt`, mutate session cost totals, or create an exception-register entry.

### Exit criteria

- A visitor can type/paste text and immediately understand its token boundaries, including visible whitespace and IDs.
- The panel is fully keyboard usable and works with network inference deliberately unavailable.
- `pnpm check` and `pnpm test` pass.

---

## Phase 3 — Chat

### Goal

Deliver gateway-routed single-turn/short-history **Chat** with streaming output and the first real cost-bearing run.

### Deliverables

1. Add reviewed text-generation descriptors and a task-specific request schema.
2. Implement Chat application use case via `InferencePort`; add a task route and SSE stream route with typed start/delta/completed/problem events.
3. Capture the AI Gateway log ID after stream completion and expose the run receipt/metrics lifecycle.
4. Implement `GET /api/runs/:runId/metrics` with bounded log propagation retry and an ownership check that compares the run's recorded identity against the current verified identity.
5. Implement the client `useRun`/`useChat` composables, stream cancellation, late-event protection, Run Details, local history, and session cost meter updates.
6. Add Chat ↔ View Tokens handoffs.

### Tests introduced

- **Domain:** prompt/options validation, gateway options always present, stream terminal-state transition, metrics aggregation.
- **Worker:** SSE event order, Access/authz, request body limit, gateway error mapped to problem details, metrics pending/available/unavailable states.
- **Gateway metadata:** the first real inference carries the signed-in user's verified email; a spoofed email in the request body or a header is ignored; a second identity produces different metadata for the same prompt.
- **Ownership:** one identity cannot read another identity's run or run metrics, and that denial is a problem-details response rather than an empty result.
- **Client:** streamed text rendering, Cancel, final receipt handling, cost pending state, cost update, and handoff to View Tokens.
- **Integration:** authenticated streaming route; no raw prompt and no email in structured logs; mock gateway log resolves on retry.

### Exit criteria

- Chat visibly streams and later displays its AI Gateway log ID and reported cost without blocking the answer.
- Repeating an eligible prompt can visibly show the gateway cache result when the provider/model supports it.
- The AI Gateway log for a Chat run is attributable to the signed-in user, and the demo discloses that attribution before the first request.
- `pnpm check` and `pnpm test` pass.

---

## Phase 4 — Create Image

### Goal

Deliver **Create Image** with reviewed text-to-image models, parameter-aware form controls, safe binary/media handling, and cost display.

### Deliverables

- Add text-to-image descriptors, validation, and gateway-backed use case.
- Implement prompt, optional negative prompt, supported size/aspect/seed/steps controls, examples, gallery, result metadata, and download.
- Validate/render returned image bytes or provider URL safely; never trust a declared browser content type alone.
- Add Create Image run details and history comparison.

### Tests introduced

- Descriptor-control compatibility and image-generation request validation.
- Worker binary response/media URL normalisation and unsupported parameter errors.
- Client gallery, alt text, download label, loading/failure states, and cost presentation.
- Integration test for authenticated gateway-routed image run using an inference-port fake.

### Exit criteria

- A generated image is rendered with accessible fallback/description, model metadata, and a cost-bearing run receipt.
- `pnpm check` and `pnpm test` pass.

---

## Phase 5 — Describe Image

### Goal

Deliver **Describe Image** for image-to-text/vision models.

### Deliverables

- Add image upload/paste input with strict type, signature, byte, and dimension limits.
- Add an optional question/instruction field and vision model descriptors.
- Implement image-to-text use case, rendering input preview beside streamed or complete answer.
- Add a handoff from Create Image while retaining standalone upload capability.

### Tests introduced

- Image validation rejects malformed, oversized, unsupported, and mismatched-signature files.
- Worker maps image plus instruction to the vision task only; arbitrary URL input is rejected until an SSRF-safe URL design exists.
- Client paste/upload preview, accessible image labelling, handoff, and result states.
- Integration auth and body-size-limit cases.

### Exit criteria

- A visitor can upload an image or hand off one generated in-app and receive a gateway-routed description with run cost.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 6 — Remix Image

### Goal

Deliver **Remix Image** for image-to-image transformation.

### Deliverables

- Add image-to-image descriptors and controls only where declared (instruction, strength, mask, seed, output size).
- Reuse validated image intake without coupling feature presentation components.
- Render source/result with accessible before/after comparison that also works without drag gestures.
- Offer Create Image → Remix Image handoff.

### Tests introduced

- Input/mask/strength validation and descriptor-specific control restriction.
- Worker task routing and media response normalisation.
- Client before/after keyboard controls, fallback two-image layout, and handoff flow.

### Exit criteria

- A user can safely submit a source image plus supported transformation controls and compare result/cost.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 7 — Classify Image

### Goal

Deliver **Classify Image** with structured top-k results.

### Deliverables

- Add image-classification descriptor(s), top-k and threshold request validation.
- Render ranked labels and confidence bars next to the original image.
- Clearly explain that confidence is model output, not a guarantee, and distinguish it from generative answers.

### Tests introduced

- Structured classifier response normalization and ordering/threshold edge cases.
- Client confidence-bar semantics, table alternative, and keyboard-readable output.
- Worker rejects classification options unsupported by the selected model.

### Exit criteria

- Results are accessible, ordered, and understandable without relying on bar colour alone; runs show gateway metrics/cost.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 8 — Create Video

### Goal

Deliver **Create Video** with a task-neutral async media-job contract.

### Deliverables

1. Confirm selected text-to-video model’s current AI Gateway support before implementation.
2. If gateway routing works, implement it through `InferencePort`; otherwise create the first reviewed, documented exception before code lands.
3. Add `MediaJob` application port/state machine, accepted-job receipt, authenticated polling status route, bounded polling, cancellation capability, and video player/download UI.
4. Add prompt, supported duration/aspect controls, progress/failure/expiry messaging, poster frame, and clear cost-pending state.
5. If model/provider requires persistent callbacks or asset storage, stop and add a dedicated infrastructure design phase before implementation; do not quietly introduce R2 or a Workflow.

### Tests introduced

- Job state machine, transition/error/retry/cancel rules, and route ownership tests.
- Client polling/backoff/cancel/late-poll suppression and video-player accessibility.
- Gateway route test or exception-register triad test if the gateway cannot carry the operation.
- Integration test for job status authorization and finite polling timeout.

### Exit criteria

- A user sees truthful progress, failure, and cancellation state instead of a frozen request.
- Gateway cost is shown when available; a documented exception displays uncosted status clearly if unavoidable.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 9 — Animate Image

### Goal

Deliver **Animate Image** as its own top-level panel while sharing the Phase 8 media-job implementation.

### Deliverables

- Add image-to-video descriptors, validated source image intake, optional motion prompt, and supported duration/resolution controls.
- Reuse `MediaJob` and player infrastructure, not Create Video’s UI route or a mode switch.
- Implement side-by-side image/video result layout and Create Image → Animate Image handoff.

### Tests introduced

- Image-to-video request validation and descriptor control compatibility.
- Client confirms Animate Image has its own route/title and no nested Create Video mode.
- Job adapter reuse contracts plus handoff/error states.

### Exit criteria

- A user can animate an upload or generated image on `/animate-image`, with the same truthful job/cost behaviour as Create Video.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 10 — Generate Music

### Goal

Deliver **Generate Music** with audio-asset response handling and non-token billing education.

### Deliverables

- Add `elevenlabs/music-v2` and/or `minimax/music-2.6` only after confirming Unified Billing/gateway compatibility and account prerequisites.
- Implement style/mood prompt, instrumental flag, optional lyrics, supported track length/output format controls, and explicit model-specific differences.
- Normalise provider audio URLs into a safe media result; show provider-hosted/expiry caveat.
- Add audio player, waveform if practical without a heavy dependency, lyrics display, download, duration, and reported pricing unit/cost.
- Reuse the job infrastructure only if selected model is asynchronous; do not assume it is.

### Tests introduced

- Lyrics/track-length/format validation per descriptor.
- Audio URL scheme/host policy and expiring-asset response behavior.
- Client player keyboard controls, transcript/lyrics display, and per-track/per-second cost labels.
- Session ledger test mixing Chat and music costs without assuming all costs are tokens.

### Exit criteria

- The session meter demonstrates different billing units correctly and never derives a music charge from tokens.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 11 — Read Text

### Goal

Deliver **Read Text** (text-to-speech).

### Deliverables

- Add reviewed TTS descriptors, voice/language/rate/pitch controls when supported, and output audio normalization.
- Render accessible player, audio duration, download, and original text alternative.
- Add Translate Text → Read Text handoff contract in advance of translation delivery.

### Tests introduced

- TTS request validation and unsupported voice/control rejection.
- Client player controls, text alternative, download, and empty/error states.
- Worker gateway routing, metrics receipt, and safe audio response handling.

### Exit criteria

- Text is rendered as playable audio with an accessible equivalent and reported cost.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 12 — Transcribe Audio

### Goal

Deliver **Transcribe Audio** (automatic speech recognition / speech-to-text).

### Deliverables

- Add audio upload and optional browser microphone recording with clear permission flow; do not require microphone support for basic use.
- Validate audio type, signature, byte length, and duration where feasible.
- Add language hint and timestamps/diarization controls only when supported by descriptor.
- Render transcript, segments/timestamps, confidence where returned, copy/download, and audio/text association.

### Tests introduced

- Audio validator and recording-permission state tests.
- Structured transcript normalization, timestamp ordering, and confidence missing/available cases.
- Client keyboard flow for upload, permission denial, transcript copy/download.
- Integration tests for authorization and bounded async state where provider requires a job.

### Exit criteria

- Audio can be transcribed without microphone permission, and recorded audio failure/permission states are clear.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 13 — Translate Text

### Goal

Deliver **Translate Text**.

### Deliverables

- Add translation descriptors and strict source/target language validation.
- Implement source/target selectors, swap action, examples, line-break preservation, side-by-side result, and copy action.
- Complete Translate Text → Read Text handoff using an explicit typed event rather than shared mutable component state.

### Tests introduced

- Language pair validation, swap operation, and preserved line endings.
- Client labels/language accessibility, copy feedback, and Read Text handoff.
- Worker routes only selected descriptor/task-compatible language values.

### Exit criteria

- The translated text is visibly separate from source, copyable, and transferable to Read Text; metrics/cost work as for other inference panels.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 14 — Classify Text

### Goal

Deliver **Classify Text** as fixed-label classification, distinct from Evaluate Choices.

### Deliverables

- Add reviewed text-classification descriptors and declared modes/labels (such as sentiment, topic, or emotion).
- Implement examples, text input, threshold/top-label display, structured raw response disclosure, and explanatory copy distinguishing labels from free-form generation.
- Cross-link to Evaluate Choices but do not share the task API/schema.

### Tests introduced

- Classification request/response normalization and fixed-label compatibility.
- Client confidence bars/table alternative and raw-response disclosure semantics.
- Regression test proving arbitrary caller-defined question criteria are rejected by this task.

### Exit criteria

- The panel teaches conventional classification and is demonstrably distinct from structured Jev evaluation.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 15 — Evaluate Choices

### Goal

Deliver **Evaluate Choices**, the structured-evaluation panel for `typesafe/jev`.  In addition, `clef` is now available from Cloudflare and should be the default choice.  See <https://blog.cloudflare.com/clef-decision-models/>.

### Deliverables

- Add the Jev descriptor, typed state input (text/JSON), and question-builder domain schema.
- Support `noul`, `choice`, and `score` questions with criteria and explicit request JSON preview.
- Render type-specific result cards: probability bar, choice distribution, score gauge/legend, and separate confidence display.
- Add prepared support-triage, refund-policy, moderation, and lead-qualification scenarios.
- Add a View Tokens handoff for state size/context awareness.

### Tests introduced

- Domain schema tests for each question type, criteria, JSON state, and response normalization.
- Worker rejects generic Chat input and invalid/missing question contracts.
- Client question add/remove/reorder, JSON synchronization, visual and textual result alternatives, and confidence distinction.
- Cost-ledger test for the model’s input-priced/free-output shape without hardcoding a price calculation.

### Exit criteria

- Caller-defined typed questions receive typed, calibrated results with no “parse model prose as JSON” path.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 16 — Semantic Search

### Goal

Deliver **Semantic Search** using gateway-routed embeddings and local vector comparison.

### Deliverables

- Add `@cf/baai/bge-m3` and/or `@cf/qwen/qwen3-embedding-0.6b` after confirming current model contracts.
- Implement editable curated collections, query input, reviewed similarity metric (cosine similarity by default), and local ranking.
- Implement a content-derived embedding cache key and visible cache indicators. Cache scope is the current browser/application session until a storage design is separately specified.
- Return aggregate run metrics plus individual inference records: query embedding and every cache-miss passage embedding.
- Render rank, relative score explanation, model/dimension/vector summary, comparison between models, and a deliberately limited raw-vector disclosure.
- Keep this in-memory. Do not add Vectorize, D1, or R2 merely for this panel.

### Tests introduced

- Cosine-similarity math, zero-vector handling, deterministic ranking ties, cache keys, cache hit/miss aggregation, and descriptor dimension validation.
- Worker test for aggregate receipt/cost state covering query plus passage calls.
- Client test that scores are labelled as relative rather than probability/confidence; model comparison and raw vector disclosure.
- Integration test confirming all embedding calls use the gateway client and metrics aggregate without exposing passage text in telemetry.

### Exit criteria

- A visitor sees semantic similarity outrank lexical overlap where the curated data demonstrates it.
- Aggregate cost accurately reflects all inference calls in a search, while cached passages remain visibly free of new inference.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 17 — Cross-panel hardening, documentation, and presentation readiness

### Goal

Turn the completed panels into a polished reference demo without changing the mandatory architecture.

### Deliverables

1. Perform an accessibility review across all panels: headings/landmarks, focus order, keyboard media controls, form errors, status announcements, colour contrast, mobile layout, and motion preferences.
2. Review security limits and error handling: JSON/media limits, unsafe URL policy, job ownership, run ownership, cancellation, input validation, no sensitive telemetry, and provider-error sanitisation.
3. Complete all JSDoc and README content:
   - task/panel catalogue;
   - architecture, four tiers, and the `src/worker/` layout;
   - AI Gateway invariant and exception register;
   - AI Gateway cost lifecycle and caveats;
   - the authentication model: Access-protected throughout, open to any identity the provider accepts, with no application-level allowlist;
   - the identity-attribution disclosure: the verified email is recorded in AI Gateway metadata, what that means for gateway logs and analytics, and where a user sees it stated in the UI;
   - Unified Billing/credit prerequisites for third-party models;
   - local development, deployment, teardown, and presenter walkthrough.
4. Create `DEMO.md` describing the presenter sequence from Chat through View Tokens, Semantic Search, Evaluate Choices, image/video, music, translation/TTS, and Activity/Gateway cost comparison.
5. Reconcile every model descriptor against the current catalog; remove unavailable models rather than leaving dead selectors.
6. Verify clean-checkout developer journey with repository-root `.env` only: install, local Access, `pnpm start`, and no `.dev.vars` dependence.
7. Perform an actual deploy/teardown smoke run in a deliberately approved account, checking that the account is clean afterwards. This is manual verification, not an offline test.
8. Audit observability across every panel against [Cross-phase observability requirements](#cross-phase-observability-requirements). Per-phase compliance does not guarantee consistency: confirm that event names follow one `<task>_run_started` / `<task>_run_failed` convention, that every panel correlates on the same run-ID field name, that no panel logs prompt content or the verified email, and that a single run ID search returns a complete story for each one. Inconsistent field names are the failure mode here — they make a cross-panel log search impossible while every individual panel looks correct.

### Tests introduced

- Cross-panel keyboard/E2E-style DOM tests for route navigation, shared run details, history, session meter, and all handoffs.
- Exception-register checker test covering empty and non-empty fixture registers.
- Privacy regression scan/assertions for absent prompt/media payloads from structured logs and metadata builders, and for the email appearing in gateway metadata but never in Worker structured logs.
- A cross-panel observability test, driven from the task catalogue so a later panel is covered automatically, asserting that every delivered inference panel emits a start line before its model call, logs a bound cause on failure, and uses the shared run-ID field name.
- A metadata-contract test that runs across every delivered inference task, so a panel added later cannot omit the verified email.
- Terraform/config contract test confirming gateway lifecycle and Access audience output remain wired correctly.

### Exit criteria

- Every panel has its declared task type, safe validation, gateway/cost behaviour, help text, and test coverage.
- Every inference task attributes its gateway metadata to the verified signed-in user, and the UI and README disclose that attribution.
- `AI-GATEWAY-EXCEPTIONS.md` is accurate and explicitly empty or complete.
- `pnpm check`, `pnpm test`, `pnpm start`, `pnpm deploy`, and `pnpm teardown` satisfy the repository definition of done.
