# Demo 9: Cooperative Architect Drawing

Directory: `demos/architect`

Domain: `architect.cfapps.uk`

Status: Phases 0-6 complete. Phase 5's deployed Workflow readiness blocker is resolved: a
deployed smoke verification (`wrangler workflows trigger` directly against the real
`architect-architecture` Workflow) reached both a `ready` job with a schema-valid R2 proposal and
a durable `failed` job after the model rejected an impossible schema request. That verification
also found and fixed two defects not caught by local-only testing: the `generate` step's
1-second timeout (copied from Spike 08's synchronous local fixture config, too short for a real
Workers AI call) and `extractResponseText()` rejecting the already-parsed object
`response_format` actually returns. Phase 6 (public publishing) is implemented, tested, and
deployed. Phase 7 (verification, documentation, and cleanup) is next.

Cloudflare products: Workers, Static Assets, Cloudflare Access, Durable
Objects, D1, R2, Workers KV, Workflows, and Workers AI.

## Summary

This demo is a focused architecture-diagram editor for an architect and a
customer or sales engineer. Authenticated users can build a Cloudflare
architecture together, see each other's presence and cursors, and ask Workers
AI to propose a diagram through a durable Workflow. An owner can publish an
immutable version at an anonymous, read-only link.

The design combines the strongest ideas from the two prior-art projects:

- `CF-Architect`: a Cloudflare product catalog, editable nodes and edges,
  blueprints, and anonymous read-only sharing.
- `interactive-demos`: AI-generated architecture documents, live cursors, and
  one Durable Object per diagram.

The implementation must use the repository's Vue, Vite, Vuetify, Pinia, Hono,
Terraform, Wrangler, Access, testing, and documentation conventions. Prior-art
code is a behavioral reference only; do not copy its React/Astro code or
private source verbatim.

## Goals

- Make two authenticated users editing one diagram the primary demonstration.
- Keep one Durable Object authoritative for each live diagram.
- Show presence, remote cursors, and edits in both browsers without refresh.
- Use a Workflow for durable AI proposal generation, retries, and visible
  progress. Workflows are not part of the real-time editing path.
- Let the owner invite editors and publish an anonymous read-only version.
- Give D1, R2, and KV distinct, easy-to-explain responsibilities.
- Make every important action visible in the UI, Workers Logs, or Workflows
  dashboard.

## Non-Goals

- General-purpose whiteboarding, freehand drawing, comments, chat, or file
  uploads.
- CRDT or operational-transformation research. The Durable Object serializes
  edits and rejects stale revisions with a full resync.
- Pixel-perfect parity with either prior-art application.
- Generated deployment-ready Terraform or application source code.
- AI chat, RAG, external model providers, or autonomous changes to a diagram.
- Anonymous editing. Anonymous users can only view a published version.
- Complex organization roles. A diagram has one owner and zero or more
  editors.

## Primary Demo Flow

1. Sign in as User A, create a diagram from a small blueprint, and add or edit
   a product node and connection.
2. Create an editor invitation. Open it as User B in a second browser window
   and accept it.
3. Keep both windows open. Move each cursor and edit different parts of the
   diagram. Each user sees the other's cursor, presence, and accepted edits.
4. Ask Workers AI to propose an architecture for a short application
   description. Watch its Workflow progress, preview the proposal in both
   windows, and accept it as one atomic diagram revision.
5. Publish the diagram. Open the share link in an anonymous window and verify
   that it is read-only.
6. Open Workers Logs, the Durable Objects view, the Workflow instance, D1, R2,
   and KV in the Cloudflare dashboard to show where each part of the demo
   lives.

## Relevant Skills

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `durable-objects`
- `testing-durable-objects`
- `workers-best-practices`
- `wrangler`
- `vue-best-practices`
- `vue-pinia-best-practices`
- `vue-router-best-practices`
- `vue-testing-best-practices`
- `web-perf`

## Product Responsibilities

| Product | Responsibility |
| --- | --- |
| Durable Objects | One coordination room per diagram: authoritative document, ordered revisions, WebSockets, presence, and cursors. |
| D1 | Diagram directory, owner/editor membership, invitation records, publication metadata, and AI job directory. |
| R2 | Immutable published snapshots and AI proposal documents. |
| Workers KV | Fast anonymous share-token lookup to the current published R2 snapshot. |
| Workflows | Durable AI generation steps, retry policy, status, and completion notification. |
| Workers AI | Produce a structured architecture proposal from the prompt and current diagram summary. |
| Cloudflare Access | Authenticate all editor pages, APIs, invitations, and WebSocket upgrades. |

Do not duplicate the live graph in D1. Durable Object SQLite is authoritative
for editable state; D1 is the relational directory around it. Published R2
objects are immutable versions, not a second writable copy.

## Access Model

Use two Access applications on the hostname:

- A hostname-wide public `bypass` application for the landing page,
  `/share/*`, and `/shared/*`.
- A more-specific authenticated application with explicit destinations for
  `/app*` and `/api/*`, backed by an `allow` policy for any authenticated
  identity.

Mount `cloudflareAccess()` on authenticated Worker routes and validate the
authenticated application's audience. The WebSocket upgrade handler must
authorize diagram membership in D1, remove any client-supplied identity or
role headers, and add trusted values before forwarding to the Durable Object.
The Durable Object trusts only those Worker-added values.

Require same-origin requests for every state-changing API and WebSocket
upgrade. Mutations also require an exact JSON content type. Reject a missing or
foreign `Origin` before reading a body, redeeming a token, or forwarding an
upgrade.

Use one shared path-policy array in the Worker and
`cloudflareAccessPlugin()` for local development. List public and protected
paths explicitly, default to block, provide at least two selectable local
identities, and render an unconditional `/cdn-cgi/access/logout` control.

An editor invitation is a random, single-use, expiring capability. Store only
its SHA-256 digest in D1. Redeeming it requires Access authentication and adds
that identity to `diagram_members`; the redemption page lives under the
protected `/app/invitations/:token` route. Public share tokens are separate and
grant read-only access only to an already-published R2 object.

## Data And State Model

### D1

- `diagrams`: `id`, `owner_email`, `title`, `created_at`, `updated_at`.
- `diagram_members`: `diagram_id`, `email`, `role`, `joined_at`; unique on
  diagram and email.
- `diagram_invites`: token digest, diagram ID, creator, expiry, and redemption
  fields.
- `diagram_shares`: token digest, diagram ID, current R2 object key,
  publication revision, created/updated timestamps, and optional revocation
  timestamp.
- `architecture_jobs`: job ID, Workflow instance ID, diagram ID, base revision,
  requester, status, proposal R2 key, and timestamps.

### Durable Object SQLite

`DiagramRoom extends DurableObject<Env>` is addressed with
`DIAGRAM_ROOM.getByName(diagramId)`. Store:

- A singleton document containing the validated graph and current revision.
- A bounded operation table keyed by `operationId` for deduplication and
  troubleshooting.

Persist an accepted operation and its new revision before broadcasting it.
Connections store verified identity and display metadata with
`serializeAttachment()` so hibernation does not lose identity. Presence and
cursor positions are transient and rebuilt from active WebSockets.

The graph contract is renderer-independent: products, external actors, edges,
annotations, and viewport. Vue Flow positions and selection state remain client
concerns unless needed to reproduce the diagram. A single curated product
catalog supplies labels, categories, icons, handles, and documentation links.

## Collaboration Protocol

- On connect, send the full document, current revision, and participants.
- A durable edit contains `operationId`, `baseRevision`, `kind`, and a small
  validated payload.
- If `baseRevision` is current, apply it, increment the revision, persist, then
  acknowledge and broadcast the accepted operation.
- If it is stale, reject it and send the current full document. The client
  resyncs and asks the user to retry; it does not silently merge.
- Cursor, selection, and drag-preview messages are transient and rate-limited.
  Persist only the final node position on drag end.
- AI proposal acceptance is one atomic replacement operation. Reject it when
  the proposal's base revision is stale.

This is deliberately simpler than CRDT/OT while still producing deterministic
behavior when two users edit at once.

## AI Workflow

The editor submits a short application description. Enforce prompt and graph
size limits, one active job per diagram, and a small per-user start rate. The
Worker records an `architecture_jobs` row with the current diagram revision and
starts an `ArchitectureWorkflow` instance whose ID is the job ID.

The Workflow performs a short sequence of durable steps:

1. Set `summarizing`, build a compact semantic summary of the current diagram
   and curated product catalog, then notify the room.
2. Set `generating`, call one verified Workers AI model using structured JSON
   output, and report retry attempts without exposing prompt content.
3. Set `validating`, validate the result against the shared architecture schema
   and product catalog. Unknown products or invalid edges fail clearly; never
   map them silently to Workers.
4. Set `storing`, write the proposal JSON to a deterministic R2 key, then set
   the D1 job to `ready`.
5. Notify the diagram's Durable Object after each status change. It broadcasts
   progress and the final proposal status to connected editors.

The Workflow may retry the model step with bounded exponential backoff. Catch
terminal step failures and run an idempotent finalization step that sets
`failed` in D1 and notifies the room, so a job cannot remain `running`. Its side
effects must be idempotent so a retry cannot create duplicate jobs or objects.
The proposal never changes the diagram by itself. Editors preview it, then
explicitly accept or reject it. Acceptance fails if anyone changed the diagram
since the Workflow captured its base revision. A user retry creates a new job
and Workflow instance; it never reuses a retained instance ID.

## Implementation Plan

### Phase 0 - Spikes (tag: `phase-00-spikes`)

Keep each spike disposable and record results under `spikes/<name>/REPORT.md`.
The report must separate source-verified, locally verified, and deployed
findings and record exact package, Wrangler, and workerd versions.

#### Spike Execution Rule

This account requires every deployed Worker endpoint to have a Cloudflare
Access application and policy. It also prevents the account endpoint used by a
Workers AI or AI Gateway remote binding from being covered by a suitable Access
policy. Therefore:

- **Never use a remote binding in a spike.** This includes Workers AI,
  AI Gateway, D1, R2, KV, and any other `remote: true` binding. Do not use
  `wrangler dev --remote` either.
- A **local spike** runs only local Wrangler/workerd simulations through
  `wrangler dev` and Vitest. It creates no Cloudflare resources and needs no
  Terraform. If the feature has no local simulation, inject a local fake at
  the application seam instead of reaching Cloudflare.
- A **deployed spike** is required for Workers AI, AI Gateway, or behavior that
  must be verified on Cloudflare's runtime. It must expose a small HTTP probe
  on its own `*.workers.dev` hostname. Terraform must create a hostname-wide
  Access application with an explicit `bypass` policy before the probe is run.
  Wrangler deploys the Worker code; the probe script calls only that Worker
  over HTTP. The script must delete the Worker and run `terraform destroy`
  after recording the result, including failure cleanup.
- Deployed spikes run only with explicit operator approval and the root `.env`.
  They must not share resources with a demo or another spike.

Existing reports contain useful precedent, but some also used remote bindings
or direct Cloudflare API/model probes that are forbidden for this demo. Reuse
only their source-verified findings and results obtained through a deployed,
Access-bypassed Worker HTTP endpoint:

- `spikes/00-aichatagent-basics/REPORT.md` provides the deployed Worker plus
  bypass Access lifecycle and a successful Worker -> Workers AI result reached
  through that Worker. Its `remote: true` configuration is historical evidence
  only and must not be copied.
- `spikes/05-workers-ai-speech-to-text/REPORT.md` repeats the deployed Worker ->
  Workers AI -> HTTP probe pattern. Reuse those HTTP-path findings only; do not
  reuse its direct REST probe path.
- `spikes/02-dynamic-workers-egress-control/REPORT.md` proves that a Durable
  Object and `@cloudflare/vitest-pool-workers` can run fully locally. It does
  not test collaborative WebSockets or this diagram protocol.
- `spikes/01-ai-gateway-dynamic-routing/REPORT.md` and
  `spikes/04-ai-gateway-cost-reconciliation/REPORT.md` provide a Terraform
  Access lifecycle precedent, but their direct AI Gateway API findings are not
  admissible evidence for this demo. This demo does not currently use AI
  Gateway. If it is later added, verify it with a new deployed HTTP-probe spike,
   never a remote binding or direct probe-script API call.

#### Measured Spike Decisions (2026-08-07)

- Spike 06 selected Vue Flow `1.48.2` with Vue `3.5.40` and Vuetify `4.1.6`.
  Persist a versioned renderer-independent graph document, keep shared cursors
  in graph coordinates, and transform them for each client viewport. Initial
  delivery excludes ELK: it produced correct layouts, but its static import
  added 539.52 kB gzip to the small editor bundle. Retain an optional lazy-load
  seam if user feedback justifies auto-layout later.
- Spike 07 selected a SQLite singleton-document table plus a bounded operation
  table, updated together with `storage.transactionSync()` before broadcast.
  Use `sync`, `operation_accepted`, `resync`, and transient `cursor` frames;
  stale edits receive the entire current document and are never retried
  automatically. Limit cursor broadcasts to one per socket every 50 ms. Use
  close codes `4400` for malformed frames and `4401` for an absent trusted
  identity. Integration tests must set `fileParallelism: false`, best-effort
  close tracked clients without awaiting their close events, then call
  `evictAllDurableObjects({ webSockets: "close" })` in `afterEach`.
- Spike 08 proved the local Workflow/D1/R2/Durable Object binding layout and
  durable status model. Keep the fake generator seam as
  `generate({ fixture, attempt, summary }) => raw text`; only the generation
  step retries, with one retry after the initial attempt. D1 writes each named
  state before the room notification. The supported Vitest pool can create and
  inspect an instance and its D1/R2/DO effects, but does not provide a verified
  deterministic single-step control; use durable side effects for automated
  assertions and Local Explorer for manual inspection.
- Spike 09 selected `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with
  `response_format: { type: "json_schema", json_schema }` through `env.AI`.
  The 679-byte architecture schema validated small and medium fixtures; the
  impossible fixture was rejected by the binding/model path, so the Workflow
  must persist that class of failure. Keep independent validation because JSON
  Mode does not guarantee schema adherence. `guided_json` is not the selected
  adapter.
- Spike 10 proved deployed D1 plus Durable Object terminal-failure reporting
  and the Worker/Access/D1/R2 teardown order, but did not prove a successful
  deployed Workflow execution: the replacement-model instance remained
  `queued` for three minutes. Do not claim local/deployed parity, AI-to-R2
  success, or completion of this risk until a fresh deployed readiness probe
  observes both `ready` and an invalid-fixture `failed` result.

#### Spike 06 - Vue Diagram Editor

Directory: `spikes/06-architect-vue-editor`

Mode: **Local** (`vite dev`; no Terraform and no Cloudflare resources).

**Unknowns to prove:**

- Whether current Vue Flow works cleanly with Vue 3, Vuetify, TypeScript, and
  the repository's Vite setup without React-only dependencies.
- Whether custom product nodes, typed/labeled edges, palette drag/drop, node
  property edits, viewport restore, and a true read-only mode cover the primary
  editor flow.
- How screen coordinates map to flow coordinates for palette drops and remote
  cursor rendering at different pan/zoom levels.
- Whether ELK auto-layout is small and reliable enough to include, or should be
  left out of the demo.

**Probe:** build one small local page with five catalog products, one external
actor, two edge types, editable properties, saved/restored JSON, and a read-only
toggle. Open two browser windows with different viewport positions and verify a
recorded cursor coordinate maps to the same graph point in each.

**Report must decide:** package versions, graph JSON contract, coordinate
conversion, component boundaries, read-only enforcement, and whether ELK is in
or out. Do not continue to Phase 1 with the editor library still undecided.

**Measured decision:** Vue Flow is selected. Use the versioned graph contract
and graph-space cursor protocol recorded in `spikes/06-architect-vue-editor/REPORT.md`.
ELK is out of the initial bundle.

#### Spike 07 - Collaborative Diagram Room

Directory: `spikes/07-architect-collaboration`

Mode: **Local** (`wrangler dev` and Vitest; local Durable Object only, no
Terraform and no Cloudflare resources).

**Unknowns to prove:**

- Whether two hibernatable WebSockets can use the current declarative
  `exports` configuration and recover trusted identity attachments after
  eviction.
- Whether the proposed `operationId`/`baseRevision` protocol produces one
  deterministic revision when two clients edit concurrently.
- Whether operation persistence and document update can be atomic in Durable
  Object SQLite, and duplicate operation IDs remain harmless after reconnect.
- Whether transient cursor/selection frames can remain unpersisted while final
  drag positions persist and replay correctly.
- Which cleanup sequence avoids the known hibernatable-WebSocket test hangs
  documented by the `testing-durable-objects` skill.

**Probe:** use a minimal graph with two nodes. Connect two scripted WebSocket
clients over localhost, send concurrent edits from the same base revision,
verify one acceptance and one stale resync, retry a duplicate operation, move
both cursors, evict the Durable Object, and reconnect.

**Report must decide:** exact frame schemas, SQLite tables/transaction shape,
close codes, cursor rate limit, resync behavior, and the integration-test
cleanup recipe. This spike does not use Access; stand-in identities are added
by the local Worker's upgrade handler solely to test the trusted-header seam.

**Measured decision:** use the frame, SQLite, close-code, rate-limit, and
cleanup decisions recorded in `spikes/07-architect-collaboration/REPORT.md`.

#### Spike 08 - Local Workflow Orchestration

Directory: `spikes/08-architect-workflow-local`

Mode: **Local** (`wrangler dev` and Vitest; local Workflow, D1, R2, and Durable
Object simulations; no Terraform and no Cloudflare resources).

**Unknowns to prove:**

- Whether the current Wrangler/workerd combination runs a Workflow that reads
  D1, writes R2, and calls a Durable Object using the final binding layout.
- Whether named progress states reach the room in order and survive Workflow or
  Durable Object restarts.
- Whether a caught exhausted step can run the finalization step that writes
  `failed` to D1 and notifies the room.
- Whether deterministic job IDs and R2 keys make retries idempotent.
- Whether the repository's supported Vitest integration can start, advance,
  inspect, and clean up a Workflow instance without polling a real account.

**Probe:** compile a fake architecture generator into the spike and inject it
at the same interface the real Workers AI adapter will implement. Exercise
success, malformed output, one transient retry, exhausted retries, duplicate
start, unknown products, invalid edges, and Durable Object notification. Use
only local D1 and R2 data.

**Report must decide:** Workflow step boundaries, retry configuration, progress
and failure semantics, fake-AI interface, instance inspection mechanism, and
test cleanup. It must not contain an `AI` binding because Workers AI has no
local simulation on this account.

**Measured decision:** use the seven durable step boundaries and generator seam
from `spikes/08-architect-workflow-local/REPORT.md`; assert terminal behavior
through D1, R2, and Durable Object effects rather than per-step harness control.

#### Spike 09 - Workers AI Structured Architecture Output

Directory: `spikes/09-architect-ai-structured-output`

Mode: **Deployed** (Terraform Access bypass plus Wrangler deployment; driven
only through HTTP; complete teardown required).

**Unknowns to prove:**

- Which current Workers AI model reliably returns the proposed architecture
  schema through the deployed `env.AI` binding.
- Whether `guided_json` or `response_format` is the correct live input for that
  model and what response shape the binding actually returns.
- Whether the schema and curated catalog fit comfortably in the request and
  how reliably the model stays within them. Deterministic rejection of unknown
  products and invalid edges is already proved locally in Spike 08.
- Real latency and failure behavior for a small, medium, and intentionally
  invalid fixture. Cost totals are not needed.

**Probe:** deploy a minimal Worker with an `AI` binding and fixed fixture IDs.
`POST /probe` selects a committed fixture, calls Workers AI, validates the
result with the proposed schema, and returns validation status and timing only.
Do not expose an arbitrary public prompt endpoint and do not log fixture or
model output.

**Infrastructure and lifecycle:** follow the proven Terraform pattern in
`spikes/05-workers-ai-speech-to-text`: create a bypass Access policy and
application for the spike's `*.workers.dev` hostname, deploy with Wrangler,
call `/probe` over HTTP, delete the Worker, then destroy the Access resources.
Do not run `wrangler dev`, add `remote: true`, or call Workers AI directly from
the probe script.

**Report must decide:** model ID, exact request/response adapter, schema size,
validation behavior, measured latency, and the fixtures retained for later
tests.

**Measured decision:** use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and
`response_format` JSON Schema, retaining the `small`, `medium`, and `invalid`
fixture IDs. See `spikes/09-architect-ai-structured-output/REPORT.md` for the
safe response adapter and observed timings.

#### Spike 10 - Deployed Architecture Workflow

Directory: `spikes/10-architect-workflow-deployed`

Mode: **Deployed** (Terraform-managed Access bypass, D1, and R2; Wrangler
deployment; driven only through HTTP; complete teardown required).

**Unknowns to prove:**

- Whether the exact locally tested Workflow can call the selected Workers AI
  model on Cloudflare, persist a proposal to R2, update D1, and notify a
  deployed Durable Object.
- Whether progress and terminal failure behavior observed locally match the
  deployed Workflow runtime.
- Whether the Workflow, declarative Durable Object `exports`, AI binding, D1,
  and R2 can coexist in one Worker deployment and generated binding types.
- Whether the complete teardown order removes the Worker/Workflow/DO before
  emptying and destroying R2 and D1.

**Probe:** expose only `POST /jobs` to start one committed fixture and
`GET /jobs/:id` to read status. The GET route must read the D1 job and the
Durable Object's last notification so the HTTP probe proves both paths. Run one
successful job and one deliberately invalid fixture that reaches durable
`failed`; do not add a browser or remote binding.

**Infrastructure and lifecycle:** Terraform creates the bypass Access
application/policy, D1 database, and R2 bucket. Wrangler deploys the Worker,
Workflow, Durable Object, and bindings. The runner applies D1 migrations,
drives the endpoints over the Access-bypassed `*.workers.dev` hostname, deletes
the Worker, empties R2, and runs `terraform destroy`, even after a failed
assertion.

**Report must decide:** deployed/local parity, final binding and class
configuration, observed status transitions, HTTP polling contract, teardown
order, and any correction required in Phase 5.

**Measured decision:** final bindings and teardown order are viable, but
deployed Workflow start readiness is unresolved. The observed model-deprecation
failure did finalize in D1 and the Durable Object; a later replacement-model
instance remained queued. Resolve this with a new isolated deployed HTTP probe
before claiming Phase 5 completion.

**Phase 0 result:** all five reports exist, no remote binding was used, and both
deployed spikes completed teardown. Editor, collaboration, local Workflow, and
Workers AI adapter decisions are fixed above. The deployed Workflow readiness
risk remains open: it blocks the Phase 5 completion claim, not Phase 1 through
Phase 4 implementation. A follow-up isolated HTTP-probe deployment must prove
one `ready` job and one validation-driven durable `failed` job before Phase 5
is declared complete.

### Phase 1 - Scaffolding And Access (tag: `phase-01-scaffolding`)

1. Create `demos/architect` with the canonical layout and Vue 3, Vite,
   Vuetify, Pinia, Vue Router, Feather Icons, Hono, and TypeScript.
2. Provision with Terraform: Worker registration, bootstrap deployment, custom
   domain, Access applications/policies, D1, R2, KV, Workers Logs, and tracing.
   Put explicit `depends_on` references from the Worker to D1, R2, and KV.
3. Commit one `wrangler.jsonc.tpl` and `infra/local-outputs.json`. Bind `DB`,
   `SNAPSHOTS`, `SHARES`, `DIAGRAM_ROOM`, `ARCHITECTURE_WORKFLOW`, and `AI`;
   configure Static Assets SPA fallback and run the Worker first for `/api/*`
   and `/shared/*`. Declare `DiagramRoom` as a SQLite Durable Object with the
   current Wrangler `exports` lifecycle model, not the legacy `migrations`
   array, and add the Workflow declaration.
4. Wire local and production Wrangler generation, generated binding types, D1
   local/remote migrations, build, check, test, deploy, and complete teardown.
   R2 teardown must empty the bucket before Terraform destroys it.
5. Add global logging, RFC 9457 errors, Access middleware, shared access
   policies, local Access emulation, `GET /api/me`, a public landing page, an
   authenticated empty app shell, and logout.
6. Create the initial D1 migration for all tables in Data And State Model.

**Testing:** verify Access on page/API/WebSocket paths, public bypass paths,
binding generation, migrations, and the empty responsive shell.

**Definition of done:** `npm run deploy` can produce an empty secure app and
`npm run teardown` leaves no named or billable resources.

### Phase 2 - Personal Diagram Library And Editor (tag: `phase-02-editor`)

1. Implement owner-scoped diagram list/create/open/rename APIs and D1
   repositories. Creating a diagram also creates the owner membership row.
2. Implement `DiagramRoom` document initialization, read/update RPC methods,
   graph validation, revisioning, and deletion cleanup. The Worker checks D1
   membership before every Durable Object call.
3. Build a focused editor using Vue Flow: searchable product
   palette, product and external nodes, labeled typed edges, properties panel,
   delete, pan, zoom, fit, and a few useful blueprints. Keep the
   catalog modest rather than copying every prior-art item. Keep ELK out of the
   initial bundle; add it only as a lazy-loaded follow-up if needed.
4. Save edits through revisioned commands even with one user so Phase 4 does
   not replace the persistence model.
5. Emit `diagram_created`, `diagram_opened`, and `diagram_updated` structured
   logs without graph content or user email.

**Testing:** cover graph validation and command application, owner isolation,
editor interactions, blueprint creation, reload from Durable Object state, and
recovery after Durable Object eviction.

**Definition of done:** one authenticated user can create, edit, reload, and
reopen a durable diagram.

### Phase 3 - Collaborator Invitations (tag: `phase-03-invitations`)

1. Add owner-only create/list/revoke invitation APIs and authenticated redeem
   flow. Enforce single use, expiry, random tokens, and digest-only D1 storage.
2. Add the editor membership role to diagram list/open authorization. Return
   `404`, not `403`, when a caller probes a diagram they cannot access.
3. Build the invitation dialog, copy-link action, protected
   `/app/invitations/:token` redemption page, and member list. Only the owner
   can invite or publish; owner and editor can edit.
4. Ensure an invitation cannot be confused with a public share token.

**Testing:** cover expired, revoked, reused, malformed, and cross-diagram
tokens; owner-only controls; and User B gaining access only after redemption.

**Definition of done:** User A can grant User B durable editor membership with
one expiring link.

### Phase 4 - Live Cooperative Editing (tag: `phase-04-collaboration`)

1. Add the authenticated WebSocket upgrade route. Authorize membership in D1,
   enforce same-origin, inject trusted identity/role headers, and route by
   validated diagram UUID.
2. Implement the Collaboration Protocol with hibernatable WebSockets,
   persisted revisions, deduplicated operation IDs, acknowledgements, stale
   revision resync, participant join/leave, and transient cursor/selection
   broadcasts.
3. Add the client connection composable and Pinia collaboration store with
   reconnect/backoff, full-state hydration, optimistic pending state, and
   clear conflict recovery. Do not retry a rejected stale edit silently.
4. Render participant avatars/names and distinct remote cursors. Announce
   connection/conflict state accessibly and honor reduced motion.
5. Emit `participant_joined`, `participant_left`, `operation_accepted`, and
   `operation_rejected` logs. Do not log graph payloads or cursor positions.

**Testing:** connect two identities to the same room and prove bidirectional
edits and cursors; prove a different diagram is isolated; reject a non-member;
deduplicate retries; resync a stale revision; and recover after hibernation.

**Definition of done:** two authenticated editors can work in the same diagram
and always converge on the Durable Object's accepted revision.

### Phase 5 - Workflow-Backed AI Proposals (tag: `phase-05-ai-workflow`)

1. Implement `ArchitectureWorkflow` exactly as described in AI Workflow, with
   bounded retries, deterministic IDs/keys, shared schema validation, and
   idempotent D1/R2 writes. Use
   `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through the verified
   `response_format` JSON Schema adapter, and retain independent validation.
   Use a top-level failure path that durably sets
   `failed` and notifies the room after retries are exhausted.
2. Add owner/editor APIs to start a proposal and read its status. The Worker
   derives diagram identity, membership, and base revision server-side. Enforce
   request size limits, one active job per diagram, per-user throttling, and an
   idempotency key.
3. Let the Durable Object broadcast job progress and the completed proposal to
   all connected editors. Use the named states `summarizing`, `generating`,
   `validating`, `storing`, `ready`, and `failed`. Store only proposal metadata
   in live room state; the proposal document remains in R2.
4. Build prompt, progress, preview, accept, reject, failure, and retry UI.
   Accepting applies one atomic revision; a stale proposal asks the user to
   regenerate instead of overwriting newer work. Retry creates a new job ID.
5. Emit `architecture_job_started`, `architecture_job_completed`,
   `architecture_job_failed`, and `architecture_proposal_accepted` logs without
   prompt or generated document content.

**Testing:** use a fake AI binding for valid, malformed, transient-failure, and
permanent-failure outputs; prove progress, terminal failure finalization,
throttling, single-active-job enforcement, retries, and idempotency; prove both
editors see progress/result; and reject acceptance after an intervening edit.
Keep the real Workers AI check as an optional, explicitly authorized deployed
smoke test because it has no local model simulator.

**Definition of done:** a natural-language request becomes a validated,
previewable proposal through a visible Workflow and changes the shared diagram
only after explicit acceptance. Before this phase is complete, an isolated
deployed smoke probe must demonstrate both a `ready` job and a validation-driven
durable `failed` job after Workflow scheduling begins.

### Phase 6 - Public Publishing (tag: `phase-06-publishing`)

1. Add owner-only publish/update/revoke APIs. Publishing writes a new immutable
   R2 snapshot under a revision-addressed key with create-only semantics,
   records it in D1, and updates a high-entropy KV token-digest key to point at
   that object. Never reuse an R2 key or expose editable Durable Object state
   directly to an anonymous request.
2. Use links shaped as `/share#<token>` so the capability fragment is never
   sent in an HTTP URL or invocation log. The public viewer reads the fragment
   and sends it in the JSON body of `POST /shared/resolve`; the Worker hashes it
   before D1/KV lookup and returns only the read-only snapshot. Set a restrictive
   referrer policy, validate expiry/revocation metadata, and document that KV
   revocation is eventually consistent because the content was deliberately
   published publicly.
3. Build a read-only viewer with pan, zoom, fit, product details, and no editing
   or collaboration connection. Add owner controls to copy, update, and revoke
   the share.
4. Emit `diagram_published` and `diagram_share_revoked` logs without tokens or
   graph content.

**Testing:** prove anonymous access to a valid publication, no write or
WebSocket path from the viewer, unpublished/unknown/revoked behavior, immutable
old R2 versions, create-only R2 writes, KV digest pointer updates, and that raw
tokens do not appear in request URLs or storage.

**Definition of done:** the owner can publish a safe anonymous read-only link
without exposing the live editor.

### Phase 7 - Verification, Documentation, And Cleanup (tag: `phase-07-complete`)

1. Close coverage gaps across the standard worker, client, and integration
   Vitest projects. Keep Durable Object/WebSocket cleanup deterministic and use
   the Phase 0 Workflow test mechanism.
2. Run formatting, linting, type checking, coverage, production build,
   Wrangler generation/type checks, `terraform fmt -check`, and `terraform
   validate`. Run the `web-perf` review and a WCAG 2.2 AA review on editor and
   public viewer desktop/mobile layouts.
3. Verify single-command deploy and teardown, including D1 migrations, Workflow
   deployment, Worker deletion, R2 emptying, and removal of generated files.
4. Write `README.md` as the operator guide, `DEMO.md` as the exact two-user and
   dashboard presentation script, and `EXPLAIN-DEMO.md` as the product/data-flow
   explanation with current Cloudflare links. Add accurate JSDoc to every
   authored TypeScript declaration.
5. Reconcile this plan with spike reports and implemented behavior. Remove dead
   code, stale comments, unused bindings, unsupported catalog entries, and all
   generated local configuration from version control.

**Definition of done:** the complete Primary Demo Flow is reproducible, all
verification passes, documentation stays in its assigned lane, and teardown
leaves no demo resources.

## Non-Negotiable Tests

- Every authenticated API and WebSocket route rejects an unauthenticated
  request; public routes cannot mutate or join a room.
- State-changing HTTP and WebSocket routes reject missing or foreign origins.
- A non-member cannot discover, read, edit, invite to, publish, or connect to a
  diagram.
- Two clients in one room converge; clients in different rooms remain
  isolated.
- Identity and role come from Access and D1, never a WebSocket message.
- An accepted edit is persisted before broadcast and survives eviction.
- Duplicate operation IDs do not apply twice; stale revisions resync safely.
- Workflow retries do not duplicate D1 rows or R2 objects.
- Workflow exhaustion produces a durable `failed` status in both D1 and the
  connected clients; paid job creation is bounded.
- AI output is schema-validated and never mutates a diagram without acceptance.
- Public shares return only immutable published fields and never the editable
  room document or membership data.
- Teardown empties R2 and removes Worker, Durable Object namespace, Workflow,
  D1, KV, Access, and custom-domain resources.

## Key Risks

- **Editor library fit:** settle Vue Flow and layout support in Phase 0;
  avoid building a custom canvas unless the spike proves it necessary.
- **Concurrent edits:** revision rejection is intentional. Do not add CRDT/OT
  unless real use shows that the simpler protocol cannot support the demo.
- **Workflow testing:** pin the supported local harness behavior in Phase 0 and
  do not defer Workflow verification to a live account.
- **AI drift:** keep one shared schema and curated catalog, pin a verified model,
  and fail unknown products rather than guessing.
- **Public revocation:** KV is eventually consistent. Published content is
  intentionally public; use fragment tokens plus digest-only storage, document
  the short revocation window, and never use this pattern for private data.
