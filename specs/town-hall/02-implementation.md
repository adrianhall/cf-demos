# Town Hall — Phased implementation plan

## 1. Purpose and delivery rules

This plan implements the RTK-only first release in [`01-specification.md`](./01-specification.md)
and the product intent in [`00-introduction.md`](./00-introduction.md). Stream Live is deliberately
not part of the default release path: it begins only at the separately gated extension phase in §9.

Every phase must deliver a visible, reviewable increment. A phase is not complete merely because its
internal layer exists: a reviewer must be able to use the increment locally, and deployment checkpoints
must use the normal provision/deploy/teardown lifecycle when account credentials are available.

### 1.1 Non-negotiable rules for every phase

1. Work test-first at public boundaries. Write a failing test against the relevant domain service,
   application port, HTTP route, Durable Object protocol, or client interaction before implementing
   its production behaviour. Tests assert observable outcomes, not private SDK calls or SQL strings.
2. Test every main interface's happy path and relevant failure paths before closing the phase:
   invalid input, unauthenticated/unauthorized caller, missing/revoked resource, conflict or stale
   state, and dependency/transport failure where the interface exposes one.
3. Run **both** `pnpm check` and `pnpm test` at the end of **every phase**, and record their successful
   output in the phase review evidence. `pnpm check` is write-free and includes generated binding-type
   freshness, strict TypeScript, `oxfmt --check .`, type-aware Oxlint, Terraform `validate` and
   `fmt -check`, and a dry production build. `pnpm test` runs the full suite with coverage enabled.
4. `pnpm test` enforces Istanbul global minimums of **80% branches, functions, lines, and statements**
   across every authored runtime file in `src/**/*.{ts,vue}`. Only tests, generated declarations, and
   configuration files outside `src` are excluded. Routes, composition roots, adapters, Durable
   Objects, Vue components, and provider integration code may not be excluded to improve a metric.
5. Coverage must remain meaningful. Exercise a route through its Hono app, a D1 adapter through a
   Workers-runtime test, a Durable Object through its RPC/upgrade boundary, and a UI component through
   DOM interaction. Direct-import tests are reserved for deliberately pure values and validation.
6. Preserve the four-tier direction: UI → API → application/domain → infrastructure. Routes never
   construct repositories or provider clients; UI never calls a Cloudflare binding directly;
   infrastructure never trusts a client-provided identity or duplicates domain policy.
7. Use pnpm, TypeScript strict mode, `cf`, Cloudflare Vite tooling, Terraform v5, Oxfmt, Oxlint,
   Vitest, and the shared Worker library. Do not add Wrangler, npm/yarn lockfiles, a demo-local `.env`,
   hand-written platform binding types, or a live-service dependency to tests.
8. Presenter identity comes exclusively from verified Cloudflare Access middleware. Viewer access is
   exclusively through a validated opaque grant. Raw viewer secrets, Access JWTs, RTK credentials,
   Stream keys, transcripts, and model prompts never enter logs or committed files.
9. Add complete JSDoc as code is written. Update the README whenever a command, configuration value,
   privacy decision, limitation, or operator action becomes visible; do not defer documentation to the
   final hardening phase.
10. Before review, run `pnpm start` with local persisted state and check the increment in desktop and
    narrow browser layouts, including primary keyboard paths. At the stated checkpoints, run
    `pnpm deploy`, a bounded smoke test, and `pnpm teardown`; teardown must delete the application
    before Terraform destroys its resources.

### 1.2 Test and coverage bootstrap

Phase 1 establishes these project-wide conventions and no later phase may weaken them:

- Vitest has pure unit, DOM/client, contract, and Workers-runtime integration projects. Runtime
  integration has a finite 30-second timeout. Playwright is added when browser journeys exist.
- `@vitest/coverage-istanbul` includes all `src/**/*.{ts,vue}` and enforces global 80% thresholds for
  branches, functions, lines, and statements. `pnpm test` invokes `vitest run --coverage`; an optional
  `test:coverage` is only an alias, never a weaker command.
- Fakes implement public ports. RealtimeKit, translation, and repository fakes pass the same relevant
  contract suites as the concrete adapters, without copying their implementation details.
- Fixtures represent HTTP, RTK-event, transcript-frame, and DTO values—not database rows, private
  object state, or live credentials.
- Tests name caller-visible outcomes. A deliberately deferred combinatorial test is labelled as a
  hardening test rather than presented as the original design test.

## 2. Phase 1 — Foundation, lifecycle, and safe shell

### Goal

Create a deployable `cf-terraform-demos/town-hall` package that demonstrates the real project seams:
Access-protected presenter shell, a public viewer shell, typed Worker configuration, Terraform-owned
infrastructure, local D1, and a coverage-enforced test system. No real media needs to publish yet.

### Deliverables

1. Create the pnpm workspace package with strict TypeScript, Vue 3 Composition API, Vite, Hono,
   Valibot, Vitest/Istanbul, Cloudflare Vite tooling, Terraform, and `@demos/worker-common`. Pin any
   prerelease deliberately. Configure type-aware Oxlint, root Oxfmt policy, and generated Worker types.
2. Add `cloudflare.config.ts` using `defineWorker()` and `defineConfig()`. Resolve local bindings from
   committed `infra/local-outputs.json` and production bindings from ignored `infra/outputs.json`.
   Explicitly configure compatibility date, observability, assets, D1, Durable Object, and Access
   values; include `.cloudflare/types/index.d.ts` in TypeScript but do not commit it.
3. Create Terraform split by concern: provider/root-env loading, application Worker/bootstrap/custom
   hostname, Access policies, D1, Durable Object binding, and scalar documented outputs. Terraform
   owns infrastructure only; `cf` owns built-code upload and bindings.
4. Add an initial D1 migration for `broadcasts` and hashed `viewer_grants`, including timestamps,
   lifecycle state, safe provider room identifier, grant expiry/revocation, and indexes. Do not add a
   transcript table or raw secret column.
5. Create lifecycle scripts using `run-s`: `start`, `check`, `fix`, `test`, `deploy`, `teardown`, and
   runnable substeps. Use repository-root D1 migration helper scripts; local development persists to
   `.cloudflare/state`. Deploy applies Terraform, writes outputs, migrates, builds, and `cf deploy`s;
   teardown deletes the Worker before Terraform destroy.
6. Implement the Worker composition root, RFC 9457 error/not-found handlers, structured logging,
   `createAccessMiddleware`, local Access emulation, `/api/me`, health, and a public viewer landing
   route. All presenter routes are Access-gated and validate the Access audience in the Worker.
7. Build the responsive application shell: application heading, presenter sign-in/protected state,
   viewer-link entry placeholder, status-card components, loading/error affordances, semantic
   landmarks, visible focus, and reduced-motion baseline. Vue components use Composition API and
   shared typed API client modules.
8. Add README setup, architecture diagram, root `.env` prerequisites, local identity instructions,
   lifecycle commands, and the explicit statement that transcript/media integrations are not live yet.

### Test-first interface work

- Test configuration/output loading and generated type freshness using only committed local outputs.
- Test Access success, missing/wrong-audience/expired token, and case-insensitive smuggled identity
  header rejection through the Hono application in Workers runtime.
- Test D1 migration and repository round-trip for a broadcast metadata record and a digest-only viewer
  grant. Assert raw grants are never returned from repository status projections.
- Test problem-details mappings, origin/media-type protection for mutations, and safe health/public
  shell behaviour.
- Test shell states, keyboard navigation, responsive transcript placeholder placement, loading/error
  feedback, and untrusted API-response rejection through DOM tests.

### Something to review

Run `pnpm start`. A reviewer can see the responsive Town Hall shell, distinguish the protected
presenter path from the public viewer path, sign in through local Access emulation, and observe safe
problem details rather than stack traces. At this checkpoint, run deploy then teardown to prove the
application and infrastructure lifecycle.

### Exit criteria

`pnpm check` and coverage-enforcing `pnpm test` both pass with at least 80% for all four Istanbul
metrics. `pnpm start`, deploy, and teardown work from a clean checkout using only root configuration;
no presenter identity or secret is trusted from a browser header/body, and no raw viewer secret is
persisted.

## 3. Phase 2 — Broadcast domain, presenter control, and viewer grants

### Goal

Deliver the first end-to-end control-plane slice: an authorized presenter can create, start, configure,
end, and revoke access to a broadcast; a viewer link grants only a bounded viewing projection.

### Deliverables

1. Define shared Valibot schemas and runtime-neutral DTOs for broadcasts, layouts, lifecycle states,
   viewer grants, and safe public/presenter projections. Add pure domain state-transition and layout
   validation modules.
2. Define `BroadcastRepository`, `ViewerGrantRepository`, and `RealtimeKitPort`; implement D1 adapters
   and fakes. The application service owns presenter authorization, transition rules, grant rotation,
   expiry, and revocation.
3. Implement server-only RealtimeKit room creation and lifecycle adapter behind the port. Keep API
   credentials in bindings; only provider room metadata and short-lived role tokens can cross an
   application boundary.
4. Add presenter routes for create/get/start/end/layout and viewer-link rotate/revoke; add viewer grant
   resolution route. Use `currentIdentity()` and server-side presenter authorization in every mutation.
5. Build a usable presenter console: title/create form, lifecycle control, current broadcast status,
   layout picker, viewer link revealed once with copy action, revoke action, and destructive end
   confirmation. Build viewer waiting/live/disconnected/ended status views.
6. Document viewer-link lifetime, revocation, and first-release transient-data policy in the README.

### Test-first interface work

- Test every allowed and prohibited state transition, presenter ownership denial, invalid layout, end
  idempotency, missing broadcast, and RTK-adapter failure through the service contract.
- Test grant entropy/digest handling, one-time raw-link DTO, expiry, revocation, malformed-link and
  wrong-broadcast non-enumeration behavior.
- Run contract tests against fakes and concrete D1/RTK adapter seams. Runtime tests validate Access
  audience/actor checks and origin/JSON requirements on presenter mutations.
- Test console form validation, clipboard failure fallback, revoke/end confirmations, viewer waiting
  and ended states, and keyboard operation.

### Something to review

A presenter creates a broadcast, selects an initial layout, copies the one-time viewer link, opens it
in another browser context, revokes it, and observes the viewer receive a safe unavailable state. The
presenter can start/end the session without exposing a provider credential.

### Exit criteria

Run `pnpm check` and `pnpm test`; both pass and Istanbul remains at least 80% branches/functions/
lines/statements over all authored runtime source. A viewer grant cannot perform a presenter mutation
or enumerate another broadcast, and the review journey works with fake/local media adapters.

## 4. Phase 3 — RealtimeKit media webinar vertical slice

### Goal

Replace the phase-2 media seam with a working RealtimeKit webinar: one presenter publishes devices
and screen share, and viewers receive a provider-enforced watch-only experience that follows the
presenter-selected stage layout.

### Deliverables

1. Verify the current account's RTK SDK/API capabilities in a small documented spike before merging
   production integration. Record exact supported token, webinar-role, transcription-configuration,
   and statistics APIs; do not infer them from old documentation.
2. Implement `RealtimeKitPort` concrete room/token configuration for one presenter and watch-only
   viewers. Enforce publish/subscribe permission at RTK role configuration, not just in UI controls.
3. Build presenter media preflight: enumerate/select camera and microphone, request permission,
   join/leave room, toggle camera/microphone, and begin/end browser-supported screen share. Handle
   denial, missing hardware, device loss, and provider disconnect accessibly.
4. Build video-stage components that render camera, screen-share, and selected layout consistently for
   RTK viewers: camera-only, presentation picture-in-picture, and side-by-side. Presenter layout
   changes travel through the authenticated application route and are reflected by every viewer.
5. Issue short-lived presenter/viewer join tokens only after role authorization. Never put a long-lived
   token in the URL, local storage, logs, or static configuration.
6. Add an expandable RTK/WebRTC connection-insights component reporting only reliable observed state,
   RTT, packet loss, bitrate, and relay/candidate indication. Unavailable values are labelled as such.
7. Update README with browser screen-share/audio limitations, RTK-only delivery topology, and the
   difference between RTK WebRTC diagnostics and future Stream playback.

### Test-first interface work

- Contract-test all adapter requests/responses against a fake RTK client: presenter and viewer tokens
  produce the intended role policy; provider failure produces a safe retryable application error.
- Test domain/API authorization independently of hidden buttons: a viewer request cannot receive a
  publishing token, start a room, or alter layout.
- DOM-test device states, permission denial, control labels/toggles, screen-share stopped events,
  stage layout rendering, mobile layout, and unavailable connection metrics.
- Add an offline Playwright journey using an RTK browser façade/fake: presenter joins, publishes,
  changes layout, viewer observes stage, and viewer has no publishing controls.

### Something to review

Using the target RTK account, a presenter starts camera/microphone, shares a permitted screen source,
changes all three layouts, and a viewer sees the controlled stage with no publishing capability. The
connection panel clearly identifies this as RTK/WebRTC and never asserts TURN is active unless observed.

### Exit criteria

After the RTK account smoke test, run `pnpm check` and `pnpm test`; both pass with the 80% minimum on
all metrics. Browser and runtime tests prove watch-only enforcement independent of UI visibility. The
RTK integration fails visibly and safely when unavailable, rather than leaking provider error bodies.

## 5. Phase 4 — Original-language transcription and ordered live transcript

### Goal

Deliver accessible original-language captions in a side panel and the durable coordination seam needed
for reliable reconnects: interim feedback, ordered final segments, snapshots, and a one-way live stream.

### Deliverables

1. Implement managed RTK transcription configuration for the explicit spoken language and surface
   clear active/degraded status. Do not claim automatic language detection or support for unverified
   languages.
2. Define the shared discriminated `TranscriptFrame` union and Valibot schemas for interim/final/status
   frames, stable segment IDs, monotonically increasing sequence, optional media timestamp, and bounded
   text. The protocol includes no user/author field.
3. Implement authenticated presenter transcription-event ingress. Normalize supported SDK events and
   validate broadcast ownership/session association before forwarding to a `BroadcastSession` Durable
   Object. Reject arbitrary client author, sequence, and cross-broadcast payloads.
4. Implement the per-broadcast Durable Object for bounded in-memory/DO-storage transcript coordination:
   idempotent final acceptance, interim replacement, gap buffering, ordered snapshots, reconnect
   cursors, connected one-way stream clients, and cleanup alarm after end/reconnect retention.
5. Start with SSE for viewer transcript delivery unless the actual runtime requires a WebSocket. The
   viewer receives a bounded snapshot followed by live frames; reconnect merge is by segment ID and
   sequence, not append order.
6. Build transcript panel components: current paragraph emphasis, interim distinction, auto-follow,
   scroll-back pause, Follow live, show/hide, retained active-session history, desktop side panel, and
   mobile below-video placement. Original audio mute is independent of transcript delivery.

### Test-first interface work

- Unit-test normalization, duplicate suppression, stale events, gap fill, invalid sequence, interim
  replacement, final-before-interim, snapshot bounds, and cleanup-alarm behavior.
- Run the same transcript coordinator contract against an in-memory fake and the real Durable Object
  in Workers runtime. Test a presenter retry cannot create duplicate output and a late viewer receives
  ordered history then new frames.
- Test ingress Access/ownership, malformed SDK frame, cross-broadcast injection, and provider/event
  failure mappings through HTTP.
- DOM/Playwright-test caption updates, manual scroll suspending follow, Follow live resumption,
  transcript visibility, independent audio mute, reconnect status, and narrow viewport placement.

### Something to review

A presenter speaks through RTK transcription. Viewers see interim text become a single finalized,
ordered paragraph, can scroll back without being pulled forward, then select Follow live. Refreshing a
viewer restores the bounded transcript without duplicates or reordering.

### Exit criteria

Run `pnpm check` and `pnpm test`; both pass with Istanbul at least 80% for every metric. Final segment
ordering, idempotency, reconnect snapshot, and cleanup are proven by Workers-runtime tests, while the
viewer panel remains usable with keyboard and at mobile width.

## 6. Phase 5 — Workers AI translation and language sharing

### Goal

Add multilingual transcript delivery without translating once per viewer: finalized segments are
translated at most once per active configured target language, preserve sequence, and visibly fall back
to original text on failure.

### Deliverables

1. Add configured spoken and exactly three target translation languages, validated at Worker startup.
   Keep current AI model ID/configuration server-side and document actual supported language coverage.
2. Define `TranslationPort`, Workers AI adapter, bounded prompt/context builder, timeout/retry policy,
   safe error taxonomy, and fake adapter. AI requests include only the bounded preceding finalized
   context required for consistency.
3. Extend `BroadcastSession` with active language subscriptions and a deduplication key of
   `(segmentId, language)`. Persist/mark accepted final segment state before broadcasting; perform a
   single translation request per active target language and emit pending/result/degraded frames.
4. Keep original-language selection local and translation-free. On language change, return cached
   translations or one shared pending request, never a per-viewer model invocation.
5. Add viewer language selector and translation status/fallback UI. The original text remains visible
   when translation is pending or failed; errors are concise and do not expose prompt/model details.
6. Add metrics/logging fields for language code, segment count, latency, outcome, and retry category,
   but never text, context, prompt, or model response.

### Test-first interface work

- Test language configuration, context bounds, selected-language normalization, and no-AI original
  language behavior.
- Test the coordinator with twenty simulated viewers selecting the same language: one final segment
  generates at most one adapter call for that language, even under reconnect and retry.
- Test translation success, timeout, retry, permanent failure, malformed model output, and sequence
  preservation. Verify fallback emits original text and a degraded frame.
- Test viewer language changes, cached-result display, pending state, accessible failure message, and
  the absence of transcript text in structured log fixtures.

### Something to review

Open several viewers in Spanish while a presenter speaks English. All viewers get the same translated
final segment, language switching works during the broadcast, and a forced translation failure leaves
an obvious original-language fallback instead of a blank transcript.

### Exit criteria

`pnpm check` and coverage-enabled `pnpm test` pass at the 80% global minimum for branches, functions,
lines, and statements. Contract tests demonstrate translation scales by active language, not viewer
count, and no AI credential or transcript/prompt is exposed in a client response or log.

## 7. Phase 6 — Broadcast experience, resilience, and accessibility completion

### Goal

Turn the vertical slices into a coherent, demo-ready enterprise broadcast: all presenter/viewer states
are understandable, authorization failures are safe, and desktop/mobile/keyboard experiences are
complete.

### Deliverables

1. Complete presenter and viewer lifecycle UX for waiting, live, disconnected, recovery, ended,
   revoked link, expired link, expired RTK token, unavailable transcription, and unavailable
   translation. Reconnection never silently changes a viewer's grant or role.
2. Complete semantic headings, landmarks, labels, focus management, error announcements, target
   sizes, reduced motion, colour contrast, and keyboard alternatives for every released interaction.
3. Reconcile stage and transcript layouts across common desktop, tablet, and narrow widths. Ensure the
   transcript below-video transition does not hide controls or produce horizontal scrolling.
4. Finish connection insights: sampling cadence, stale-data display, unavailable-statistics wording,
   and explicit RTK/WebRTC label. Do not add a fake TURN toggle or equate a selected relay candidate
   with a performance promise.
5. Add bounded operational safeguards: request size limits, transcript segment/context limits,
   connection cleanup, safe retry/backoff, cancellation on broadcast end, and rate limits appropriate
   to presenter event ingress and viewer token issuance.
6. Complete README: architecture, roles, local workflow, target browser/device assumptions,
   transcript/translation limitations, privacy/retention policy, diagnostics interpretation,
   deployment/teardown, and all required configuration variables.

### Test-first interface work

- Test each state transition from API through rendered presenter/viewer state, including token/provider
  failure and retry boundaries.
- Run accessibility-focused DOM tests for names, focus restoration, error announcement, keyboard
  device/layout/transcript controls, and reduced-motion modes; add offline Playwright desktop/mobile
  keyboard journeys.
- Test throttles, body/context bounds, cancellation, stale diagnostics, reconnection, viewer grant
  revalidation, and safe problem-details errors through public interfaces.
- Test all known client routes against malformed server responses so UI state never trusts an invalid
  projection/frame.

### Something to review

A reviewer starts a broadcast, disconnects/reconnects the simulated presenter, changes layout and
language, scrolls/rejoins as a viewer, sees clear degraded states, and completes the primary flow using
only a keyboard in desktop and mobile layouts.

### Exit criteria

Run `pnpm check` and `pnpm test`; both pass with complete-source Istanbul coverage at or above 80% in
all categories. The README enables a clean checkout to demonstrate the RTK-only product without
undocumented credentials, user-state assumptions, or accessibility workarounds.

## 8. Phase 7 — Security, lifecycle, and release hardening

### Goal

Perform the deferred corner-case and operational review on the finished RTK-only release. Harden real
failure modes rather than inflating coverage or hiding difficult modules.

### Deliverables

1. Review Istanbul output module-by-module. Add public-interface tests for meaningful uncovered paths
   or simplify/remove unreachable production branches; do not add negative globs or per-file waivers.
2. Add boundary tests for Unicode and maximum titles/text, link expiry race, revocation during an open
   stream, duplicate/out-of-order transcript delivery, cleanup after hibernation, translation retry
   races, simultaneous language subscription changes, device removal, and presenter end during work.
3. Perform security review of Access audience/expiry/header smuggling, viewer-link entropy/digest and
   enumeration resistance, token exposure, origin/CSRF posture, provider/AI error redaction, D1
   parameters, Terraform least privilege, and DO reachability.
4. Perform WCAG 2.2 AA browser review: contrast, landmarks, headings, keyboard flows, focus, target
   size, zoom/reflow, screen-reader names, captions/transcript affordances, and reduced motion. Fix
   concrete findings and add regression tests where suitable.
5. Rehearse full lifecycle from clean state: `pnpm check`, `pnpm test`, local start/E2E, deploy,
   authenticated presenter/viewer smoke test, then teardown. Verify named/billable resources and
   Access policies are removed or intentionally retained only when documented.
6. Store review evidence and findings in `specs/town-hall/03-mvp-review.md`; update README with known
   RTK account limits, observed diagnostics limitations, and remaining non-goals.

### Something to review

The reviewer receives a release candidate with coverage report, security/accessibility findings,
local and deployed walkthrough evidence, an account-cleanliness teardown check, and controlled error
states for every tested failure rather than crashes or provider details.

### Exit criteria

`pnpm check` and `pnpm test` pass offline with all four Istanbul measures at least 80% over all
runtime source. The RTK-only first release satisfies the specification's non-negotiable acceptance
conditions, and the security/accessibility review has no unresolved high-severity finding.

## 9. Phase 8 — Stream Live proof of concept (gated follow-on)

### Goal

Validate—not assume—the optional scalable watch-only delivery architecture:

```text
Presenter → RealtimeKit WebRTC → composed RTMP/RTMPS output → Stream Live → HLS/DASH viewer
```

This phase begins only after Phase 7 is accepted. It does not change the default delivery mode until
all proof gates pass.

### Deliverables

1. Build an isolated, feature-gated RTK-to-Stream adapter spike using server-side Stream ingest
   credentials and RTK's currently supported output/livestream APIs. Document exact account/API
   prerequisites, lifecycle operations, output protocol, and teardown.
2. Prove composed output layout fidelity for camera-only, picture-in-picture, and side-by-side. Treat
   RTK tracks and Stream composition as separate concerns; do not assume browser stage CSS composes
   a broadcast.
3. Implement a Stream viewer adapter only after ingest succeeds: server-authorized playback metadata,
   HLS/DASH player integration, clear path labelling, playback-health UI, and access-policy review.
4. Extend transcript frames only with validated media/playback timing fields. Measure actual Stream
   encoder/player delay and test a timeline-alignment approach; label any fixed-delay experiment as
   experimental rather than synchronized captions.
5. Document Stream delivery/storage/recording implications, billing, viewer scale limits, token/key
   handling, and teardown of any Stream resources. Keep Stream recording/replay out of scope unless a
   new retention specification is approved.

### Test-first interface work

- Contract-test provider adapters, failure mapping, secret non-exposure, feature-gate behavior, and
  fallback to RTK-only mode with fake RTK/Stream clients.
- Test that Stream viewers cannot obtain RTK publisher privileges and that RTK diagnostics are not
  rendered as HLS/DASH diagnostics.
- Test timestamp/frame ordering and player alignment with deterministic simulated timelines before
  any live proof. Test player buffering/error/access states in DOM/Playwright.
- Run `pnpm check` and the full coverage-enabled `pnpm test` suite after every increment; maintain the
  80% minimum on branches, functions, lines, and statements across the expanded entire `src` set.

### Something to review

A controlled account test demonstrates actual RTK output reaching a private Stream Live input, a
watch-only Stream player receiving it, and a transcript whose timing is measured against playback.
The reviewer can distinguish this media path from RTK/WebRTC and inspect a safe RTK-only fallback.

### Exit criteria

The phase is accepted only with evidence for ingest compatibility, layout behavior, lifecycle
correctness, playback access, transcript timing, costs, and teardown. `pnpm check` and `pnpm test`
pass with all coverage dimensions at least 80%. If any proof gate fails, Stream remains a documented
unimplemented extension and the accepted RTK-only release remains unchanged.

## 10. Follow-on boundary

The following need a new specification and phased plan rather than being silently added to this one:
multiple presenters, moderated Q&A, viewer promotion, recording/replay, durable/searchable transcript
history, translated speech, additional identity providers, and a public high-scale Stream rollout.
Each follow-on must preserve presenter/viewer permission enforcement, content-privacy decisions,
complete lifecycle ownership, and the per-phase `pnpm check`, `pnpm test`, and 80% coverage gate.
