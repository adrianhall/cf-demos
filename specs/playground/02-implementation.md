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

- Add reviewed whole-image reference-editing descriptors for Cloudflare-hosted FLUX.2 Klein 4B (the default), Klein 9B, and Dev, plus P-Image-Edit and Nano Banana 2, with explicit per-model request/output adapters and only declared controls. Do not approximate this task with an inpainting model and a generated full-image mask.
- Reuse validated image intake without coupling feature presentation components.
- Retrieve provider-hosted output immediately through a strict HTTPS origin, redirect, byte-limit, and signature policy; keep the returned media transient.
- Render source/result with accessible before/after comparison that also works without drag gestures.
- Offer Create Image → Remix Image handoff.

### Tests introduced

- Input/instruction/seed validation, retired-inpainting-field rejection, and descriptor-specific control restriction.
- Worker task routing, FLUX reference-image request mapping, and safe provider-URL media normalisation.
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

- Add a reviewed image-classification descriptor for Cloudflare-hosted ResNet-50, with top-k and confidence-threshold validation. Because its schema accepts the image and nothing else, declare the result controls as applied by the application rather than by the model, and never forward them as request fields.
- Rank, filter, and truncate the response in the domain layer so every transport applies the same rules; apply the floor before the limit and break score ties deterministically. Do not rescale the surviving scores.
- Render ranked labels as an accessible table with the score present as text and the bar as `aria-hidden` decoration, beside the original image, with the structured response behind a collapsed disclosure.
- Clearly explain that a score is model output describing resemblance to training data — not the probability a label is correct, and not evidence that the right category exists in the model's label set — and distinguish it from a generative answer. Reject a generative request field rather than ignoring it.
- Treat an empty ranking as a successful run whose floor hid everything, and say so.
- Promote the shared image picker and prepared-image helpers out of the Describe Image feature folder so a third panel can reuse them without importing another panel's presentation.

### Tests introduced

- Structured classifier response normalization, including a non-array output, a malformed element, and a score outside 0–1; and ordering/threshold edge cases, including ties, an inclusive floor, floor-before-limit, and an empty ranking.
- Client confidence-bar semantics, the table alternative, and a guard asserting that removing every bar loses no information.
- Worker rejects classification options unsupported by the selected model, and rejects a generative field with an explanation.
- An architecture guard failing the build if any panel describes a score as the probability that a label is correct.

### Exit criteria

- Results are accessible, ordered, and understandable without relying on bar colour alone; runs show gateway metrics/cost.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither prompt content nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 8 — Create Video

### Goal

Deliver **Create Video** with a task-neutral async media-job contract, and introduce the first
storage product in the demo — R2 — as a deliberate, Terraform-owned infrastructure decision rather
than a convenience.

### Infrastructure analysis (completed; conclusions are binding on this phase)

Phase 8 was always going to be the phase that tested the "keep media transient" rule, so the
analysis required by [§5.5](./01-specification.md) and [§5.6](./01-specification.md) was done up
front. These are findings, not assumptions, and each one changes a deliverable below. Every model
contract must still be re-confirmed at implementation time; what follows is the shape of the
problem, not a pinned descriptor.

**Finding 1 — the provider returns a URL, not bytes.** Every text-to-video model found in the
unified catalogue (Alibaba `hh1-t2v` and `hh1.1-t2v`, PixVerse `v5.6` and `v6`, Vidu `q3-pro`)
declares an output schema of `{ video: string }` with `format: uri`, and the documented response
envelope is `{ state: "Completed", result: { video: "https://…" } }`. This panel therefore does not
receive media from the model at all; it receives a short-lived, cross-origin link to media held on
the provider's infrastructure. That single fact drives most of what follows.

**Finding 2 — `state` is an envelope field, not a job handle.** The envelope carries a `state`, but
the only documented value is `Completed`, and the call resolves when generation has finished. There
is no provider-issued job identifier to poll and no `Queued`/`InProgress` response to observe. **The
Phase 8 job state machine is therefore ours, not the provider's.** Do not design a polling adapter
around a provider job ID that does not exist. Confirm this again before implementation: if a
`Queued` envelope has appeared by then, prefer the provider's own handle over the design below.

**Finding 3 — the generation outlives the browser, not the Worker.** An HTTP-triggered Worker has
**no wall-clock duration limit** while the client stays connected, so a multi-minute inference call
fits inside a request. The constraint is the other end: when the client disconnects, tasks
associated with that request may be cancelled, and `ctx.waitUntil()` extends execution by only
about 30 seconds. A visitor who closes the tab during a two-minute render would be **billed for a
video that is then discarded** — and a panel whose whole purpose is teaching honest cost cannot
have that failure mode. This, and not a Worker timeout, is the justification for durable execution.

**Finding 4 — video needs ranged reads, and base64-in-JSON cannot provide them.** Every earlier
panel returns media as base64 inside a JSON body, which works because an image is displayed all at
once. A `<video>` element instead issues `Range` requests to show a poster, seek, and play without
downloading the whole file. A base64 string in a JSON response cannot answer a `Range` request, so
reusing the Create Image transport would produce a player that cannot seek. R2 answers ranged reads
natively, and `R2Bucket.put()` accepts a `ReadableStream`, so provider bytes can be piped into
storage without ever being buffered whole in a 128 MB isolate. Memory headroom is the secondary
argument here; **seeking is the one that makes R2 non-negotiable.**

**Finding 5 — a provider link is not a result we can show.** The URL is cross-origin and
short-lived, so rendering it directly would make the panel's primary result depend on an external
host's retention policy, would leak the visitor's IP to that host, and would break for a run opened
from history minutes later. Copying the bytes into R2 once, immediately, and serving them from our
own authenticated route is what makes the result ours to describe truthfully.

**Finding 6 — Workflows makes D1 and KV unnecessary.** A Workflow instance already is a durable,
queryable job record: `instance.status()` reports `queued`/`running`/`complete`/`errored`/
`terminated`, `output` carries the finished result, and completed state is retained for days. Adding
D1 or KV alongside it would mean **two sources of truth for one job status**, and the usual
consequence is a job that one store calls finished and the other calls running. **Do not add D1 or
KV in this phase.** If a later phase needs a durable session ledger across devices, that is its own
decision with its own justification.

**Finding 7 — ownership can be proven without a job table.** The status route still has to refuse
another visitor's job, which normally argues for storing an owner alongside the job. Instead, derive
the Workflow instance ID from a keyed hash of the verified email and the browser-generated run ID.
The status route recomputes the ID from the *current* verified identity and the requested run ID, so
a different identity necessarily computes a different ID and sees a `404`. Ownership becomes
unforgeable and unenumerable with no stored mapping, which is what keeps Finding 6 true.

**Finding 8 — retrying an inference step re-bills it.** Workflow steps retry by default, and that is
usually the point of them. Here, the inference step can cost several dollars, so a default retry
policy would silently multiply the charge for a transient provider fault. **The gateway inference
step must be configured with no retries;** only the subsequent fetch-and-store step, which is cheap
and idempotent, may retry.

**Finding 8a — a Workflow boundary destroys a `ProblemDetailsError`.** Found during
implementation, and worth recording because it silently defeats the error handling every earlier
panel relies on. A Workflow records a thrown error as `{ name, message }` only, so the
`problemDetails` payload — the status and the visitor-facing detail — is dropped on the way out of a
step. The first symptom was an account with no AI Gateway credit producing an unexplained "unexpected
error" in the UI: the one failure a visitor can actually resolve, reported as the one thing they
cannot act on. **Classify the cause inside the step, before it crosses the boundary,** and carry the
classification as a fixed, content-free marker token; a route must never infer a cause from a
provider's own message. Any later phase putting an inference call inside a Workflow inherits this.

**Finding 7a — the platform logs the derived instance ID, so the derivation is also a privacy
decision.** Confirmed in deployed logs after implementation. Every Workflow log line carries
`$workers.instanceId` automatically, and that value *is* the keyed HMAC of the verified email. This
demo's own log fields are clean — no email, prompt, or object key — but the platform's metadata
is not, and no application code can suppress it.

The exposure is small and worth stating precisely rather than overstating: the digest is keyed by a
secret the visitor cannot read, so it is not reversible to an email, and anyone able to read Worker
logs can already read the account's AI Gateway metadata, where the email is recorded deliberately.
It is nonetheless a *stable per-visitor-per-run identifier* in a retention domain the demo claims
holds nothing identifying, so the README's claim must be narrowed to "this application logs no
identifying field" rather than implying the log as a whole contains none. **Phase 18 should decide
whether to keep the derivation as the instance ID or move to an opaque random ID with the ownership
mapping stored** — the latter trades Finding 6's no-second-store property for a cleaner log, which
is a real trade rather than an obvious improvement.

**Finding 9 — this panel can bill several dollars per click.** Pricing is per second of output and
varies sharply by resolution: `hh1-t2v` is $0.28/s at 1080p, so a 15-second render is **$4.20**,
while PixVerse `v6` is $0.025/s at 360p, or about $0.13 for five seconds. The defaults must be the
cheap end of that range, and the panel must show an estimated cost **before** the request, not only
a reported cost after it. Every candidate model is third-party, so this panel also inherits the
prepaid AI Gateway credit prerequisite already disclosed by Remix Image.

**Finding 10 — R2 does not help Phases 2–7, and must not be retrofitted into them.** This was
examined directly, because an image-upload path that shares the video storage would be an appealing
simplification. It is a false economy. The 1 MB image-input cap is a consequence of base64-in-JSON,
not of missing storage, and it can be raised without R2 if that is wanted. Routing an upload through
R2 would not save memory either, because the vision and classification models take the image *in the
request*, so the Worker would have to read every byte back out of storage to make the call — the
bottleneck moves, it does not disappear. Download is unaffected, since the image is already in the
browser. What R2 *would* add to those panels is a retention surface, a cleanup obligation, and a
privacy claim the demo currently does not have to make. **Images stay transient; the R2 bucket is
for generated video only,** and the prefix policy below keeps that boundary enforceable rather than
merely intended.

### Decision

Introduce **R2 and Workflows**, and **no D1 and no KV**:

- **R2** holds generated video, because the result must support ranged reads and must not depend on
  a provider host. Terraform owns the bucket; the key prefix is `generated-video/`, and nothing else
  is ever written to it. Ongoing cleanup is a separate concern from storage and is deferred to the
  scheduled reaper in Phase 18, so this phase ships no expiry policy and makes no retention claim.
- **Workflows** owns the job, because the generation must survive the visitor's connection and its
  status must remain answerable afterwards. It replaces, rather than supplements, a job table.
- The `MediaJob` contract, the authenticated polling route, and the browser's polling behaviour stay
  exactly as [§5.6](./01-specification.md) specifies. The API shape does not change because the
  execution owner did.

Because this adds the first storage product, reconcile [§5.5](./01-specification.md) and
[§5.6](./01-specification.md) with the decision as part of this phase, quoting Findings 3, 4, and 6
as the platform constraints that justify it. Note honestly that the trigger was **client
disconnection**, not a Worker duration limit, so the rule stays accurate for later panels.

§5.5 currently requires that R2, when introduced, arrives with "Terraform ownership, expiry/lifecycle
policy, content cleanup, and teardown ordering". This phase delivers ownership and teardown ordering
and **defers expiry and ongoing cleanup to Phase 18**, so record that split in the specification
rather than leaving the text describing something the code does not do. The deferral is sound because
teardown already guarantees the account ends clean — the obligation Phase 18 adds is keeping a
*running* demo clean, which is a different and lesser one. It is only sound while it stays written
down: an undocumented gap here is indistinguishable from having forgotten.

### Deliverables

1. Re-confirm the selected text-to-video model's current input/output contract, envelope states,
   pricing, and AI Gateway support before pinning a descriptor. Keep it gateway-routed through
   `InferencePort`; only create a reviewed exception-register entry if routing genuinely cannot
   work, and do so before code lands.
2. Add Terraform for the R2 bucket, with a scalar bucket-name output and an explicit `depends_on`
   from the Worker so teardown orders correctly. Wire `empty-r2-bucket` into `pnpm teardown` before
   the Terraform destroy, because a non-empty bucket cannot be deleted. Bind the bucket in
   `cloudflare.config.ts` in both modes.
   **Deliberately no expiry policy in this phase.** Ongoing cleanup is deferred to the scheduled
   reaper in [Phase 18](#phase-18--cross-panel-hardening-documentation-and-presentation-readiness),
   so this phase does not have to choose a retention window, state one in the UI, or build a
   deletion path it would then replace. The consequence is accepted and bounded: between Phase 8 and
   Phase 18 the bucket grows monotonically in a demo account, and `pnpm teardown` is what keeps that
   account clean. The one thing this phase must **not** do is compensate with an informal cleanup —
   no deletion on a later poll, and no "delete the previous object when a new run starts". Either
   would become a second owner of object lifetime that Phase 18 then has to unpick.
3. Add the Workflow that performs the generation: one step calling the gateway **with retries
   disabled** (Finding 8), then one retryable step that fetches the provider URL under the existing
   strict origin/redirect/size policy and **streams it into R2 without buffering it whole**. The
   step return value carries the R2 key and byte count only — never the media, which would breach
   the 1 MiB step-result limit. Classify a failed inference inside the step and re-throw a
   content-free marker (Finding 8a), so the status route can distinguish an out-of-credit account
   from a provider fault; surface the former in the UI as an actionable notice naming prepaid AI
   Gateway credit, not as a generic error.
4. Derive the Workflow instance ID from a keyed hash of the verified identity and the run ID
   (Finding 7), in **one named function** with its own unit tests, so the derivation used when
   starting a job and when reading its status cannot drift apart.
5. Add the `MediaJob` application port and state machine, mapping Workflow instance status onto
   `accepted`/`running`/`completed`/`failed`/`cancelled`. The provider's envelope must not reach a
   route or the browser.
6. Add the authenticated status route and an authenticated, ranged-read video route that streams
   from R2, sets the sniffed content type, and never redirects to the provider. Validate the stored
   bytes are an expected container before the first byte is served, byte-authoritatively, exactly as
   the image panels do.
7. Add cancellation that terminates the Workflow instance and deletes any stored object, so a
   cancelled job leaves nothing behind.
8. Add prompt, duration, resolution, and aspect controls restricted to the descriptor's declared
   enums; an **estimated cost shown before the request** (Finding 9); truthful progress, failure,
   and cost-pending messaging; a poster frame; and the third-party credit disclosure. Expiry
   messaging arrives with the reaper in Phase 18, not here — see deliverable 9.
9. Say plainly that the video is **stored**, because this is the first panel where "transient"
   stops being literally true. Until Phase 18 adds the reaper there is no expiry, so the UI must not
   claim one: no countdown, no "available for 24 hours", no wording a visitor could read as a
   deletion promise. An honest "stored in this demo's bucket" is correct now and stays correct after
   the reaper lands; a retention claim invented here would be false in both directions — unenforced
   before Phase 18, and a different number after it.

### Tests introduced

- Job state machine: every transition, including error, cancellation, and a late poll after a
  terminal state; and a mapping test from each Workflow `InstanceStatus` to its `MediaJob` state,
  driven from the full status list so an unmapped future status fails rather than defaulting.
- Instance-ID derivation: the same identity and run ID derive one stable ID; a different identity
  derives a different one; and the status route answers `404` — never another visitor's job — for an
  ID derived from a different identity.
- A regression test asserting the **inference step is configured with no retries**, because
  Finding 8 is a cost defect that no functional test would reveal.
- Failure-classification tests: the billing condition is recognised in each documented phrasing and
  one level down a `cause` chain, an unrelated error is *not* claimed to be a billing failure, the
  classification survives the Workflow boundary round trip, and the encoding carries no provider
  text — so fixing Finding 8a cannot become a disclosure. Assert the panel tells a visitor with no
  credit that retrying will not help.
- Storage: the provider body is streamed into R2 rather than buffered; an oversized or wrong-typed
  body is refused before storage; a ranged read returns the requested bytes and correct headers; and
  cancellation deletes the object.
- A guard asserting that the only R2 keys this demo writes are under `generated-video/`, so
  Finding 10 stays true as later phases are added.
- Client polling, bounded backoff, cancellation, late-poll suppression, estimated-cost display, and
  video-player keyboard accessibility including captions/alternative affordances.
- Integration coverage for status-route authorization, the audience check, a finite polling timeout,
  and problem-details shape.
- Terraform/config contract test covering the bucket-name output, the binding name, and the
  Worker's `depends_on`.
- A test asserting the only deletion path in this phase is **cancellation**, so the informal cleanup
  ruled out in deliverable 2 cannot be added quietly before Phase 18 owns it.

### Exit criteria

- A visitor sees truthful progress, failure, and cancellation state instead of a frozen request, and
  **closing the tab mid-render does not lose a video that was paid for**.
- The result plays and **seeks** from our own authenticated route, with no request made to the
  provider's host by the browser.
- Estimated cost is visible before the request; reported gateway cost is shown when available.
- A cancelled job leaves no object behind, and `pnpm teardown` empties the bucket before destroying
  it, leaving the account clean. Objects from completed runs are expected to accumulate until
  Phase 18; that is a scheduled deliverable, not an outstanding defect in this phase.
- No part of the UI promises an expiry that nothing yet enforces.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's
  own cause on failure, correlates every line by run ID across the Worker *and* the Workflow, and
  logs neither prompt content nor the verified email. Verified with one real deployed request per
  new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 9 — Animate Image

### Goal

Deliver **Animate Image** as its own top-level panel while sharing the Phase 8 media-job implementation.

### Deliverables

- Add image-to-video descriptors, validated source image intake, optional motion prompt, and supported duration/resolution controls.
- Reuse `MediaJob` and player infrastructure, not Create Video’s UI route or a mode switch. That now includes Phase 8's R2 bucket, Workflow, and derived-instance-ID ownership scheme: reuse them rather than adding a second storage product or a parallel job mechanism. The source image still travels in the request and is still not persisted — Phase 8's Finding 10 applies unchanged.
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

## Phase 17 — Detect Objects

### Goal

Deliver **Detect Objects**, which answers *where* rather than *what*. Classify Image scores a whole picture against a fixed label set; this panel returns a set of located regions, each with its own label and score. It is the first panel whose result is spatial, and the first whose primary rendering is an overlay on the visitor's own image.

### Deliverables

- Add a reviewed object-detection descriptor for Cloudflare-hosted `@cf/facebook/detr-resnet-50` (Beta, COCO 2017, 80 categories). Confirm its current input and output contract against the model page before pinning it: at review time the catalogue page was not reachable at the usual `/workers-ai/models/detr-resnet-50/` path, so the contract must be re-read rather than assumed from ResNet-50's.
- Validate the picture with the shared byte-authoritative input rules, and reject a generative field exactly as Classify Image does.
- Apply the score floor and any result limit to the response, declaring where they are applied with the same `appliedBy` convention Classify Image established. Do not forward a control the model's schema does not declare.
- **Validate every returned box before it is rendered.** A detection carries geometry as well as a label, so the normaliser has to reject a box with a non-finite coordinate, a negative width or height, or bounds outside the image. An unchecked box paints outside its container and reads as a layout bug rather than as provider output.
- Render the detections as an overlay on the source image **and** as the same accessible ranked table Classify Image uses, with each row naming the label, the score, and the region in words. The overlay is an enhancement on a result that is already complete without it.
- Let a visitor focus or hover a table row to highlight its box, and the reverse, so the two representations are visibly one result rather than two.
- Treat "no objects detected" as a successful run and say so, distinguishing it from a run that has not happened and from a floor that hid everything.
- Reuse the shared source-image picker, the ranked-result table, the model-settings pattern, Run Details, and the session ledger. Share code, not tabs: this is a separate route from Classify Image.
- Offer a Create Image → Detect Objects handoff only if it is genuinely useful; it is secondary and must not displace the primary result.

### Tests introduced

- Detection-response normalization: a non-array output, an element missing a label or a box, a non-finite or negative coordinate, a box extending past the image bounds, and a score outside 0–1.
- Ordering and threshold edge cases, including ties, an inclusive floor, and an empty detection set.
- Client overlay geometry: a box is positioned from the model's coordinates, is clamped to the image, and scales with a responsive preview rather than being pinned to the natural pixel size.
- A guard asserting that removing every overlay box loses no information, matching the equivalent Classify Image guard: the table and its described regions remain the complete result.
- Worker rejects a control unsupported by the selected model, and rejects a generative field with an explanation.
- Integration coverage for authentication, the audience check, the body limit, identity refusal in body and header, and problem-details shape.

### Exit criteria

- A visitor can upload a picture and see located, labelled, scored regions, understandable without the overlay and without relying on colour.
- Boxes are provably inside the image, and a malformed detection is refused with a logged reason rather than rendered.
- Runs show gateway metrics and cost; nothing about this panel is exempt from the gateway rule.
- Failures are diagnosable: the panel logs an attempt before calling the model, logs the provider's own cause on failure, correlates every line by run ID, and logs neither the picture, a detected label, nor the verified email. Verified with one real deployed request per new panel. See [Cross-phase observability requirements](#cross-phase-observability-requirements).
- `pnpm check` and `pnpm test` pass.

---

## Phase 18 — Cross-panel hardening, documentation, and presentation readiness

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
8. Resolve [Finding 7a](#phase-8--create-video): decide whether the derived HMAC stays as the Workflow instance ID, given that the platform writes it into every log line automatically. Either keep it and narrow the README's privacy claim to "this application logs no identifying field", or switch to an opaque random instance ID and store the ownership mapping — which costs Finding 6's single-source-of-truth property. Also review whether the toolkit's `problemDetailsErrorHandler` should log unexpected errors itself rather than each demo wrapping it, and raise it upstream if so.
9. Audit observability across every panel against [Cross-phase observability requirements](#cross-phase-observability-requirements). Per-phase compliance does not guarantee consistency: confirm that event names follow one `<task>_run_started` / `<task>_run_failed` convention, that every panel correlates on the same run-ID field name, that no panel logs prompt content or the verified email, and that a single run ID search returns a complete story for each one. Inconsistent field names are the failure mode here — they make a cross-panel log search impossible while every individual panel looks correct.
10. Add the **scheduled R2 reaper** that Phase 8 deferred, so generated video stops accumulating without that phase having to commit to a retention window. Add a `triggers.scheduled(...)` cron trigger and a `scheduled()` handler that lists the `generated-video/` prefix and deletes objects older than a documented age, using each object's `uploaded` timestamp as the authority rather than anything encoded in its key. Own the retention age in one exported constant, assert it in a test, and state it in the README and in the panel so the UI's wording and the reaper's behaviour cannot drift apart. This is also the point at which the panel may finally describe an expiry, because one now exists.

   Four details decide whether this is correct rather than merely present:

   - **Deletion must be driven by what is in the bucket, not by what the application remembers.** A Workflow instance whose state has already aged out, or a run abandoned before it recorded anything, is exactly the object that most needs collecting. A reaper that only deletes objects it can still find a job for would leave precisely the orphans behind.
   - **Bound the work per invocation.** `list()` returns at most 1000 keys and `delete()` accepts at most 1000 per call, so page with the returned cursor and stop at a fixed budget rather than looping until the prefix is exhausted. A cron invocation has a 15-minute wall-clock limit, and a reaper that tries to drain an arbitrarily large backlog in one firing fails at the worst possible moment — when there is most to clean up. Falling behind is recoverable; a handler that always times out is not.
   - **Confine it to the prefix.** The reaper must refuse to operate outside `generated-video/`, so a future bucket user cannot have its objects collected by a job that predates it. Pair this with the Phase 8 write-prefix guard: one test proves nothing else is written there, the other proves nothing else is deleted.
   - **Log a summary, never a key.** An object key is derived from a verified identity and a run ID, so keys are identifying and belong under the same rule as the email. Log counts, the oldest age collected, and whether the budget was hit — the last of these is the signal that the schedule is too slow, and without it the reaper fails silently by simply never catching up.

   Verify it against the real deployed bucket during the smoke run in deliverable 7, with one object old enough to collect and one young enough to keep. A reaper only ever exercised against a fake is unverified in the same way Phase 4's logging was.

### Tests introduced

- Cross-panel keyboard/E2E-style DOM tests for route navigation, shared run details, history, session meter, and all handoffs.
- Exception-register checker test covering empty and non-empty fixture registers.
- Privacy regression scan/assertions for absent prompt/media payloads from structured logs and metadata builders, and for the email appearing in gateway metadata but never in Worker structured logs.
- A cross-panel observability test, driven from the task catalogue so a later panel is covered automatically, asserting that every delivered inference panel emits a start line before its model call, logs a bound cause on failure, and uses the shared run-ID field name.
- A metadata-contract test that runs across every delivered inference task, so a panel added later cannot omit the verified email.
- Terraform/config contract test confirming gateway lifecycle and Access audience output remain wired correctly, and that the cron trigger is declared with the intended schedule.
- Reaper tests: an object past the retention age is deleted and one within it is kept; the boundary case is decided by the constant rather than by a hard-coded duplicate of it; paging follows the returned cursor; the per-invocation budget is honoured and reported; a key outside `generated-video/` is refused even when it is old; and no log line contains an object key. Drive the age cases from an injected clock so the suite stays offline and instant.

### Exit criteria

- Every panel has its declared task type, safe validation, gateway/cost behaviour, help text, and test coverage.
- Every inference task attributes its gateway metadata to the verified signed-in user, and the UI and README disclose that attribution.
- `AI-GATEWAY-EXCEPTIONS.md` is accurate and explicitly empty or complete.
- Generated video is collected on a schedule, the retention age stated in the UI and README is the one the reaper enforces, and the deployed smoke run confirms it deletes an aged object while keeping a recent one.
- `pnpm check`, `pnpm test`, `pnpm start`, `pnpm deploy`, and `pnpm teardown` satisfy the repository definition of done.
