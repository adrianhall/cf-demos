# Demo 6B: Flue Agentic AI Chat

Directory: `demos/flue-agentic-ai-chat`

Domain: `flue-chat.cfapps.uk`

Status: Draft implementation plan

Cloudflare products: Workers, Static Assets, Cloudflare Access, D1, R2,
Durable Objects, Workers AI, AI Gateway, and Dynamic Workers. The agent
framework is [Flue](https://flueframework.com/).

## Scope And Framework Boundary

This is the Flue implementation of the workflow in
[`06-AGENTIC-CHAT.md`](./06-AGENTIC-CHAT.md): authenticated persistent chats,
Basic/Reasoning governed routes, dictation, per-chat cost, administrator
reporting and metadata, metadata-driven routing, R2 files, controlled URL
fetching, personal/enterprise skills, and Markdown exports.

Flue's Cloudflare target currently generates Durable Object classes **using the
Cloudflare Agents SDK internally**. Therefore, this demo uses Flue's public
agent functions, hooks, router, SDK, and Cloudflare extension APIs; it does not
author an `AIChatAgent`, an `AgentClient`, or an Agents SDK wire protocol. It
cannot truthfully eliminate the Agents SDK from Flue's transitive runtime until
Flue offers a Cloudflare target without it.

The UI may be redesigned, but remains Vue 3, Vuetify, Pinia, Vue Router, and
Feather Icons as required by `AGENTS.md`.

## Reused Findings

Do not repeat completed spikes merely because this implementation changes
framework. The following account/platform findings remain valid and are inputs
to implementation:

| Existing evidence | Reuse in this demo |
| --- | --- |
| `spikes/01-ai-gateway-dynamic-routing/REPORT.md` | Terraform AI Gateway/dynamic-route resources, route graph syntax, stable-plan workaround, working model candidates, and the fact that `aiGatewayLogId` is absent for dynamic routes. |
| `spikes/04-ai-gateway-cost-reconciliation/REPORT.md` | Per-turn UUID gateway metadata, logs-list filter encoding, authoritative fields, retry timings, and account-token requirement. |
| `spikes/02-dynamic-workers-egress-control/REPORT.md` | `worker_loaders`, `globalOutbound`, gateway allow-list behavior, local `workerd` support, and Workers Paid prerequisite. |
| `spikes/05-workers-ai-speech-to-text/REPORT.md` | Raw `MediaRecorder` WebM/Opus through `@cf/openai/whisper-large-v3-turbo`. |
| `spikes/03-agent-skills-composability/REPORT.md` | The product requirements for progressively disclosed skills and R2/D1 ownership boundaries, but not its Agents-SDK-specific implementation. |

The Dynamic Workers plan requirement remains mandatory and must be prominent in
the eventual `README.md`.

## Design

One Flue `ChatAssistant` instance is one chat and one generated Flue Durable
Object. Flue stores the canonical transcript, streamed tool activity, accepted
submissions, and its persistent state in that object's SQLite storage. D1 is
the application directory and reporting store, not a duplicate transcript:

- `users`: Access identity, administrator flag, business, and geo.
- `chats`: server-issued chat ID, owner email, title, selected route, and dates.
- `chat_usage`: one authoritative-or-estimated row per completed response.
- `chat_files`: R2 attachment metadata, owner-scoped through its chat, and the
  originating usage correlation ID.
- `skills`: owner/enterprise scope and R2-backed source metadata.

The Worker mounts `createAgentRouter(ChatAssistant)` at `/agents/chat`. A Hono
middleware before that mount verifies Access and checks D1 ownership for every
Flue route, including `POST`, history reads, SSE reconnects, aborts, and
attachment downloads. A user cannot create a Flue instance at an arbitrary ID:
`POST /api/chats` generates the ID and D1 directory row first; agent middleware
accepts only an existing row owned by the Access identity.

The Vue client wraps `@flue/sdk`'s framework-agnostic `createFlueClient()` in
one `useFlueChat()` composable. It uses `send()` for durable admission and
`observe()` for offset-resumable HTTP/SSE updates. It renders Flue text,
reasoning, data, tool, and file parts directly. There is no raw WebSocket,
reverse-engineered protocol, or React dependency in authored client code.

`ChatAssistant` uses `useModel()` and Flue's Workers AI binding provider against
the Terraform-created named AI Gateway. The browser sends only `basic` or
`reasoning`; route-to-model resolution and any caller metadata originate on the
server. The provider's documented gateway configuration is closure-captured at
module scope, so safely supplying per-chat `business` and per-turn correlation
metadata is a blocking Flue-specific question, not an assumption.

Use Flue's `useResponseFinish()` metadata for client-visible final usage and
Flue/Cloudflare lifecycle extension only where its ordering and retry semantics
are proven by Spike C. AI Gateway logs remain the authoritative cost source;
Flue's model-catalog cost is a visibly labeled immediate estimate only.

Generated files use a durable `write_markdown` tool to write R2 then D1, with a
compensating R2 delete if D1 fails. `get_url` is a Flue tool whose fixed Dynamic
Worker has no bindings and whose `globalOutbound` `EgressGateway` remains the
actual allow-list enforcement point. URL validation in the tool is only
defense in depth.

Flue's static `SKILL.md` imports cannot implement user-created skills. The
chosen implementation must prove a per-render `defineSkill()` catalog built
from the authorized D1/R2 rows, or use another Flue-supported runtime skill
mechanism. It must preserve Agent Skills progressive disclosure, remove an
upload/delete on the next turn, and never expose one user's skill to another.

## New Spikes

All new spikes follow the conventions in `06-AGENTIC-CHAT.md` section 8:
disposable code in `spikes/`, a stated aim, a report of observed behavior,
`docs/DECISIONS.md` update, and complete teardown. They are new because they
test Flue behavior, not a Cloudflare mechanism already proven by the existing
spikes.

### Spike A: Flue Cloudflare/Vue Baseline

**Aim:** establish a compatible, current Flue release and the minimal
Cloudflare deployment shape in this repository.

Use `flue init --target cloudflare --deploy` in an empty scratch directory,
then add one Vue page, `createAgentRouter`, `@flue/sdk`, `flue()` before
`cloudflare({ config: flueWorkerConfig() })`, Access middleware, and the
repository's generated Wrangler configuration pattern. Deploy behind a
bypass-only spike Access application because the live Workers AI binding cannot
be proxied locally on this account.

Prove and report:

- Exact compatible versions of `@flue/runtime`, `@flue/vite`, `@flue/sdk`,
  `agents`, Vite, Wrangler, and the Cloudflare Vite plugin.
- The generated Flue Durable Object binding/class and required migration, with
  an authored `wrangler.jsonc.tpl` still compatible with `generate-wrangler`.
- A browser-independent `@flue/sdk` `send()` plus `observe()` session renders
  a streamed response and resumes after reconnect.
- Hono Access/ownership middleware covers every agent-router subroute and is
  evaluated before durable admission.
- Whether Flue's source maps, generated Worker output, and the toolkit's Vite
  Access plugin compose without a second Worker entry or a generated-config
  conflict.

**Decision gate:** pin the verified release family and client transport. If
Flue cannot compose with the required Vite/Access/config-generation setup, stop
before application scaffolding.

### Spike B: Per-Submission Dynamic Routing Context

**Aim:** prove that a Flue `useModel('cloudflare/dynamic/<route>')` call can
safely attach the current user's D1-derived `business` and a fresh per-response
correlation UUID to a named AI Gateway without module-level mutable request
state.

Build two real dynamic routes using the already-proven Terraform graph. Drive
two authorized Flue conversations with different server-owned business values,
then inspect AI Gateway logs for the selected underlying model and metadata.
Exercise two concurrent submissions in separate conversations and a repeated
submission in one conversation.

Prove and report:

- The supported extension point for dynamic gateway metadata, if any. The
  documented `cloudflareBindingProvider({ gateway: { metadata } })` captures
  metadata at module scope, which is insufficient by itself.
- Whether `useAgentStart()` state changes can affect the same submission's
  `useModel()` choice, or only its next submission.
- The exact way Flue exposes response usage/model identity, including tool-loop
  and compaction effects.
- Whether a route can remain fixed per chat while current business metadata is
  refreshed before each turn.

**Decision gate:** no static metadata workaround is acceptable. If Flue has no
safe per-submission provider/context hook, this demo cannot meet US-7 and the
AI-Gateway reconciliation design; pause for a Flue upstream capability or a
re-scoped requirement.

### Spike C: Ledger Commit And Reconciliation Lifecycle

**Aim:** prove an idempotent Flue lifecycle design that writes exactly one
usage row for a settled response, records the correlation ID before inference,
and durably runs the existing 10s/+15s/+15s AI Gateway reconciliation flow.

Use a real Flue Cloudflare conversation and a test D1 database. Test normal
completion, a tool-containing response, an abort, a provider error, Durable
Object interruption/restart, and deletion before reconciliation. Use Flue's
response hooks, persistent state, `cloudflare` extension descriptor, and
Agents-SDK scheduling only as actually supported by the installed release.

Prove and report:

- The response identifier and callback ordering needed to avoid duplicate D1
  rows when `useAgentFinish()` runs more than once or a response recovers.
- Whether an asynchronous D1 write/reconciliation can be scheduled durably
  without overriding Flue-owned `fetch`, `alarm`, or recovery methods.
- The source of a final versus estimated token/cost value and how it reaches
  `useResponseFinish()` metadata and the Vue stream.
- The exact safe behavior when a chat is deleted while scheduled work remains.

**Decision gate:** use only a lifecycle path that preserves Flue's recovery
contract. Do not use `waitUntil()` as a retry queue or a module-global
deduplication flag.

### Spike D: Runtime, Scoped Flue Skills

**Aim:** prove personal and enterprise skills stored in R2/D1 can be mounted
at runtime with Flue's progressive disclosure, rather than only as static
build-time `SKILL.md` imports.

Create enterprise and two-owner personal fixtures. On each turn, build the
authorized catalog from D1/R2 using the candidate Flue API, then demonstrate a
matching task activates exactly one skill and a non-matching task does not.
Create, update, and delete skills between turns without redeployment.

Prove and report:

- Whether a dynamically created `defineSkill()` definition is a supported
  per-render resource and can contain R2-loaded instructions/resources.
- How asynchronous R2/D1 loading becomes available before the intended model
  turn without leaking stale skills into another owner or bloating every prompt.
- The maximum permitted size and validation path for Markdown/resource content.
- The mechanism that guarantees a deletion removes the skill on the next turn,
  including an instance restarted between deletion and that turn.

**Decision gate:** static packaged skills and an ephemeral workspace alone do
not satisfy US-10. If no supported runtime catalog exists, document the gap and
obtain an explicit product decision before implementation.

### Spike E: Flue Tools In The Generated Durable Object

**Aim:** prove Flue tool closures can safely use the generated agent's chat ID,
Cloudflare context, R2/D1, and the previously proven Dynamic Worker egress
chain while preserving Flue's tool/recovery semantics.

Implement minimal `write_markdown` and `get_url` tools. The former writes a
fixture to R2 and records D1 metadata. The latter calls `LOADER.get()` through
an `EgressGateway` with one permitted and one denied host. Force an
interruption around each tool; make writes idempotent using Flue `durable: true`
steps where the verified lifecycle requires it.

Prove and report:

- The supported way a tool obtains the current conversation/chat ID and
  Cloudflare bindings without trusting model arguments.
- Tool output parts and file attachment representation available to
  `@flue/sdk`/Vue, including whether a Flue attachment can coexist with the
  required R2 download route.
- A blocked `globalOutbound` fetch becomes a model-visible tool result rather
  than an aborted response.
- The exact R2/D1 compensation and recovery behavior, including no orphaned
  downloadable file after a D1 failure.

**Decision gate:** retain Dynamic Workers as the primary egress boundary. The
existing egress spike already validates the platform; this spike only validates
the Flue integration seam.

## Implementation Plan

Each completed phase is formatted, linted, type-checked, tested across the
worker/client/integration Vitest projects, production-built, and Terraform
validated before its tag is created. Tags use
`flue-agentic-chat/phase-<NN>-<slug>`.

### Phase 0: Run New Spikes

Run Spikes A-E. Incorporate every observed correction in this document and
`docs/DECISIONS.md`. Do not begin scaffolding until all decision gates pass.

### Phase 1: Scaffolding And Secure Conversation Directory

Create `demos/flue-agentic-ai-chat` from Flue's Cloudflare scaffold, preserving
the repository's canonical Terraform, generated Wrangler, npm lifecycle,
documentation, source organization, and three-project Vitest requirements.

Provision the Worker, custom domain/bootstrap deployment, authenticated Access
application, D1, Workers Logs/traces, named AI Gateway, and basic/reasoning
dynamic routes. Add R2 now if Spike E requires it; otherwise add it in Phase 9
with `empty-r2-bucket` teardown. Generate Flue's Durable Object migration from
the verified `ChatAssistant` identity; never hand-author its `FLUE_*` binding.

Implement global Access verification, `GET /api/me`, idempotent user/admin
bootstrap, a minimal logout-capable Vue shell, D1 `users`/`chats` migration,
and an authenticated chat create/list directory. Mount agent-router middleware
that authorizes every conversation operation by D1 ownership.

### Phase 2: Core Persistent Chat (US-1)

Add `ChatAssistant` with Flue `useModel`, the verified named gateway provider,
and Flue's durable conversation store. Add `useFlueChat()` around `@flue/sdk`.
Build a responsive transcript/composer with streamed text/reasoning, admission
and failure states, abort support, reconnect recovery, and reduced-motion
behavior.

Integration tests create a server-issued chat, submit multiple turns, reconnect
to history/updates, and prove every agent endpoint rejects a foreign owner and
an unauthenticated caller.

### Phase 3: Chat Management (US-2)

Add sidebar create/select/delete behavior, D1 ordering and titles, and safe
chat deletion. A title is generated once after the first completed response
using the verified Flue lifecycle. Deletion must remove the D1 directory row,
R2 files when present, and prevent future agent-router access without exposing
whether another user's chat exists.

### Phase 4: Governed Model Selection (US-3)

Expose exactly Basic and Reasoning. Persist the selected route before the first
submission and resolve it server-side to `dynamic/agentic-chat-basic` or
`dynamic/agentic-chat-reasoning`; never accept a model ID from the browser.
Use the model catalog proven by the existing dynamic-routing spike and recheck
it in the deployed Flue path.

### Phase 5: Dictation (US-4)

Implement the microphone workflow and `POST /api/transcribe`. Enforce a
bounded request body, post WebM/Opus unchanged, base64-encode server-side, and
call Whisper Turbo. Populate the composer only after a successful transcript;
never automatically submit it.

### Phase 6: Cost And Token Ledger (US-5)

Implement the lifecycle proven by Spike C. Add `chat_usage`, local estimate,
per-response correlation ID, D1 aggregate endpoints, authoritative AI Gateway
logs-list reconciliation, bounded durable retries, and explicit
Estimated/AI-Gateway-confirmed UI language. Stream final response metadata to
the open chat through Flue updates; refresh sidebar aggregates through the
directory API.

### Phase 7: Admin Cost And Metadata Console (US-6)

Add validated business/geo values, `requireAdmin()` on every `/api/admin/*`
route, cost-ranked users, metadata editing, and business/geo reports. Admins
can inspect costs and change routing metadata, never another user's transcript,
files, or personal skills.

### Phase 8: Metadata-Driven Routing And Governance (US-7)

Apply the dynamic-route condition nodes and rate/spend controls using the
per-submission Flue integration proven by Spike B. A metadata update affects the
next eligible turn without browser-supplied business data. Verify both branches
against AI Gateway logs and document the exact defaults for unset metadata.

### Phase 9: Generated Markdown Files (US-8)

Add the proven durable `write_markdown` tool, `chat_files`, R2 storage,
ownership-checked download route, transcript tool/attachment rendering, and
file-to-usage correlation. Test R2/D1 partial-failure compensation.

### Phase 10: Controlled URL Fetching (US-9)

Add `LOADER`, `EgressGateway`, the fixed sandboxed fetch module, strict URL
validation, and the proven `get_url` tool. Test the whole local `workerd`
chain for a blocked host and manually/deployed integration for an allow-listed
host, documenting the Workers Paid requirement.

### Phase 11: Personal And Enterprise Skills (US-10)

Use the runtime catalog proven by Spike D. Add upload/URL ingestion, text and
size validation, R2 storage, CRUD routes, D1 scope rules, personal/enterprise
management UI, and tool activity indicators. Test cross-user invisibility,
activation only for a matching task, and removal on the next turn.

### Phase 12: Markdown Exports (US-11)

Build server-side chat and file export from Flue's materialized conversation,
tool records, D1 usage, and R2 content. File exports join via the exact
correlation ID. Require owner access and test every rendered artifact.

### Phase 13: Cleanup And Documentation

Close coverage gaps and write the four required documentation layers. The
explanation must distinguish Flue's authored API from its current internal
Agents SDK dependency, explain the one REST API exception for AI Gateway log
listing, and link the Flue and Cloudflare documentation used by the shipped
implementation. Verify `npm run deploy` and `npm run teardown` orchestrate the
complete lifecycle without applying or destroying real resources during normal
test runs.

## Non-Negotiable Tests

- Access and D1 ownership protect every Flue router method, not only prompt
  submission.
- A reconnect renders the same durable conversation from Flue's stream.
- A Basic/Reasoning selection never permits a client model ID.
- Concurrent conversations cannot cross-attribute gateway usage rows.
- A cost row is immediately distinguishable as estimated or confirmed.
- A non-admin receives `403` for every admin endpoint.
- A denied URL is stopped by `globalOutbound`, not merely application parsing.
- A personal skill is absent from another owner's next render.
- A deleted chat cannot be read, resumed, exported, or reconciled back into
  existence.
