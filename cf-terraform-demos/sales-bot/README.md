# SalesBot

SalesBot is an authenticated Vue and Cloudflare Workers demonstration for internal Cloudflare sales.
Phase 3 adds the web-chat answer workflow: one authoritative D1 transcript per verified requester, a
`ConversationSession` Durable Object for ordered live WebSocket delivery and reconnect replay,
D1-rechecked AI Search retrieval, citations, a mandatory AI Gateway model client, bounded prompts,
cancellation, and an explicit product-manager escalation path. The supplied product ownership map,
audience- and expiry-aware FAQ revisions, immutable audit events, reviewed documentation manifest,
retryable indexing jobs, and administrator freshness view remain the knowledge base underneath it.

Phase 4 adds a PM escalation queue. Product-scoped PMs and administrators can answer, reject, or
reassign escalations; answers and rejections become durable turns in the requester's original web
conversation. Assignment history blocks direct and longer reassignment cycles. A PM may explicitly
publish an answer as an FAQ, which creates the normal retryable index job.

Phase 5 adds a D1-derived, product-scoped dashboard for queue volume and age, response and
resolution latency, product distribution, reassignment/rejection counts, FAQ freshness, and index
backlog. The administrator audit view supports action, resource, and correlation-ID filters.
Retention defaults to 365 days for web conversations and 730 days for audit records in
`retention_configuration`; the table makes the policy explicit before scheduled deletion is enabled.

## Prerequisites

- Node.js 24+, pnpm 12+, Terraform 1.10+, and the `cf` CLI supplied by this workspace.
- Repository-root `.env`, created with `pnpm create-env`. The deploy token requires Workers, D1, AI
  Gateway, Access, and DNS/custom hostname permissions for the configured account and zone.

## Commands

Run commands from this directory:

```sh
pnpm start          # migrate local D1, then start cf with persisted state
pnpm check          # generated types, TypeScript, Oxfmt, Oxlint, and Terraform checks
pnpm test           # offline DOM, domain, and Workers-runtime tests
pnpm test:coverage  # same tests with an 80% threshold
pnpm generate:manifest # regenerate the reviewed documentation manifest from a local docs checkout
pnpm deploy         # Terraform, remote D1 migrations, build, and cf prebuilt deploy
pnpm teardown       # delete Worker first, then Terraform resources
```

Local Access emulation offers salesperson, PM, and administrator identities; it uses the same
audience-aware policies as the deployed Worker. No `.dev.vars` file is used.

## Infrastructure and trade-offs

D1 is authoritative because the planned workflow needs relational integrity and transactions. The
migration creates the full Phase 1 data-model foundation, but Phase 1 only reads the `identities`
table. Terraform owns D1, the Access application/policy, Worker registration/custom hostname, and
the AI Gateway. `cf` owns Worker code and bindings.

AI Gateway is pre-provisioned with `authentication = true` and
`workers_ai_billing_mode = "postpaid"`. These explicit settings prevent anonymous gateway use and
make Workers AI billing behavior deliberate before Phase 3 adds model traffic.

## Knowledge-base policy

FAQs are authoritative in D1. Publishing creates revision 1; editing or archiving creates another
revision rather than mutating or erasing history. A new FAQ expires after 90 days unless its PM
selects a different date or explicitly removes expiry. Retrieval checks active status, expiry, and
the caller's audience clearance against D1 on every read — the scheduled expiry/index-cleanup work
is only cleanup, never the access-control mechanism.

A PM may publish or edit an FAQ they own or whose product is currently in their D1 product scope.
Administrators may manage every product, including cross-product FAQs. Salespeople and overseers
cannot edit knowledge. Every publication, revision, archive, expiry mark, and documentation import
is recorded in `audit_events` without storing question/answer text in the audit entry.

`src/documentation-manifest.json` is the approved source list, not a crawler configuration. It names
individual Markdown pages from `github.com/cloudflare/cloudflare-docs`, their product, title, source
revision, and SHA-256 content hash. Regenerate it only from a reviewed local checkout with
`pnpm generate:manifest`; the Worker imports the committed manifest and never reads an arbitrary URL
or filesystem path.

### Chat and answer workflow

`ConversationSession` is keyed by the D1 conversation identifier. It coordinates ordering,
cancellation, hibernatable WebSockets, and reconnect replay, but is **not** a second source of
truth: every question, answer, and escalation acknowledgement is persisted in D1 before the session
broadcasts it. A WebSocket upgrade is forwarded as the original authenticated request because a live
WebSocket cannot cross Durable Object RPC serialization and the Hibernation API completes the
upgrade against that request. Before forwarding, `withVerifiedIdentity()` deletes every client copy
of the identity, email, role, clearance, and correlation headers — including case variants — then
sets values derived only from verified Access identity and D1. A direct HTTP request to the stream
route receives `426 Upgrade Required`.

The answer workflow retrieves AI Search candidates and rechecks every FAQ against D1 status, expiry,
and the requester's current clearance before either model sees it. A deterministic evidence
threshold escalates unsupported questions; a gateway-routed decision model may only narrow that to
another escalation, never approve an answer without evidence. The answer model receives a bounded
prompt and stores citations beside its answer. The audience filter runs again immediately before
delivery, so a clearance or classification changed while generating cannot leak content. A requester
can cancel an in-flight answer or explicitly ask a product manager; reconnects replay the
authoritative transcript.

`GatewayInferenceClient` is the only module allowed to use the Workers AI binding. Every call
supplies the Terraform-managed authenticated, postpaid AI Gateway ID with content-free metadata
(verified identity key, conversation ID, correlation ID, model contract version); there is no direct
fallback. Provider errors are logged with identifiers and parameter lengths only, while the browser
receives a safe RFC 9457 message.

### AI Search deployment capability

Phase 2 deliberately models and tests the AI Search port and its retryable index-job lifecycle
without provisioning an AI Search instance. The current Terraform provider exposes an AI Search
resource, but instance availability and the final retrieval/index configuration are account and
corpus decisions that Phase 3 must validate before creating real infrastructure. Local development
uses a statically development-only in-memory index simulation. A production Worker without an
`AI_SEARCH` binding fails jobs visibly, so the administrator freshness view reports pending/failed
work rather than claiming FAQs are searchable. Once availability and schema are confirmed, Phase 3
adds the Terraform-owned instance and typed `cf` binding; no application/domain policy needs to
change.
