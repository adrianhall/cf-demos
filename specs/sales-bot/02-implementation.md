# SalesBot — Phased Implementation Plan

## Delivery rules

- Implement each phase as a demonstrable, passing repository state.
- Follow [`01-specification.md`](./01-specification.md) and preserve the four-tier direction.
- Use pnpm, TypeScript strict mode, `cf`, Terraform, Oxfmt, Oxlint, Vitest, and the shared Worker library; never add Wrangler.
- Run `pnpm check` and `pnpm test` at the end of every phase. Tests are offline and integration projects have finite timeouts.
- Add domain, Worker-runtime, DOM, and browser tests at the boundary introduced by each phase.
- Run local development with persisted state and verify desktop, narrow viewport, keyboard navigation, and failure states.
- Update README and generated types as each configuration or external-channel decision becomes visible.
- **MVP boundary:** Phases 1–6 deliver and harden the web-only product. Email and Google Chat do not
  provision resources, bindings, routes, or simulators before the MVP hardening review passes.

## Phase 1 — Foundation and authenticated web shell

Create the `cf-terraform-demos/sales-bot` package, Cloudflare configuration, Terraform ownership,
Access policies, D1 migrations, local outputs, lifecycle scripts, generated binding types, and Vue web
shell. Implement `/api/me`, health, RFC 9457 errors, structured logging, local Access emulation, and
the responsive navigation shell.

Tests cover missing, expired, wrong-audience, and valid Access identities; authorization role checks;
D1 migration round trips; safe errors; and keyboard/mobile shell behavior.

**Review checkpoint:** `pnpm start` shows the authenticated test interface and `pnpm deploy` followed
by `pnpm teardown` leaves the account clean when credentials are available.

## Phase 2 — FAQ and documentation knowledge base

Add the product-map seed, FAQ domain/application/infrastructure layers, CRUD authorization, expiry
and audience policies, audit events, documentation manifest, Cloudflare docs importer, AI Search index
jobs, and administrator freshness view.

Tests cover PM ownership, administrator override, audience filtering, default 90-day expiry, removed
expiry, expired-record exclusion before index cleanup, revision uniqueness, indexing retries, and
source-manifest validation.

**Review checkpoint:** an administrator imports selected Cloudflare Markdown documentation, creates an
FAQ, changes its audience and expiry, and observes index status without exposing restricted content.

## Phase 3 — Shared answer workflow and web chat

Implement the central retrieval and generation service, mandatory AI Gateway client, decision and
answer model descriptors, citation shaping, `ConversationSession` Durable Object, WebSocket upgrade
forwarding/header scrubbing, and web chat UI.

Persist each turn before broadcast. Add cancellation, reconnect replay, bounded prompts, correlation
IDs, AI Gateway metadata, and safe provider errors. Never add a direct Workers AI call outside the
shared client.

Tests cover retrieval filtering, insufficient evidence, explicit escalation, gateway routing invariant,
provider failures, DO reconnect/order, smuggled identity headers, and DOM chat states.

**Review checkpoint:** a signed-in tester asks a Cloudflare documentation question and receives
citations; an unsupported question produces a visible escalation path.

## Phase 4 — Escalation queue and PM actions

Implement escalation state transitions, assignment history, supplied product map, fallback to Rita
Koslov, PM scope rules, reassign-cycle prevention, answer/reject forms, web-conversation delivery, and
FAQ publication from a PM response.

Tests cover every transition, duplicate escalation prevention, prior-reassigner rejection including
longer cycles, unauthorized PM/admin operations, publication/indexing retries, and delivery to the
original web conversation.

**Review checkpoint:** a tester escalates, signs in as the assigned PM, answers or rejects, and sees
the result in the original web conversation.

## Phase 5 — Dashboards, audit, and MVP hardening

Add D1-derived dashboards for volume, queue age, first-answer time, resolution time, product breakdown,
reassignment, rejection, FAQ freshness, and indexing backlog. Add audit filtering, retention
configuration, structured operational metrics, rate limits, failure runbooks, accessibility review,
and performance/load bounds for the web-only workflow.

Tests verify dashboard calculations against duplicate web events, timestamp edge cases, authorization
scopes, safe logging, retry/dead-letter recovery, accessibility-critical interaction paths, and failure
observability by correlation ID.

**Review checkpoint:** PMs see only their scope, overseers see managed products, administrators see all
data, and the full web MVP is secure, accessible, observable, and diagnosable before any external
channel is introduced.

## Phase 6 — MVP release verification

Run full `pnpm check` and `pnpm test`, local browser journeys, accessibility checks, seeded-data review,
deployment smoke tests, and complete teardown. Verify Terraform outputs, Access policies, AI Gateway
routing, AI Search freshness, and no secret or sensitive-content leakage in logs.

The MVP is complete only when all MVP acceptance criteria in `01-specification.md` pass and the README
documents permissions, local development, deployment, teardown, retention, and known Cloudflare account
prerequisites.

---

## Post-MVP extensions

These phases begin only after Phase 6 is accepted. Each extension reuses the existing normalized
conversation and delivery ports; it must not fork the retrieval, agent, escalation, FAQ, or PM workflow.

## Phase 7 — Email channel

Configure Cloudflare Email Routing and Email Sending for the operator-controlled domain, including the
Worker `send_email` binding and required DNS authentication records. Implement bounded inbound parsing,
approved-domain and SPF/DKIM/DMARC policy, safe thread correlation, queue acknowledgement after durable
insertion, outbound transactional replies with plain-text and HTML parts, and idempotent retries.
Verify the domain is onboarded for Email Sending before enabling the channel.

The channel simulator calls the real email adapter and application service. Tests cover malformed mail,
oversized bodies, header injection, unapproved domains, ambiguous authentication, duplicate delivery,
thread continuation, outbound failure, transient retry, and permanent bounce visibility.

**Review checkpoint:** an approved-domain email creates or continues a conversation and receives the
same answer/escalation behavior as web chat.

## Phase 8 — Google Chat channel

Implement authenticated Google Chat event handling, approved spaces and direct messages, verified
identity mapping, event idempotency, thread replies, unsupported-event handling, and the console
simulator.

Tests cover invalid authentication, unapproved spaces, forged message identities, duplicate events,
unrelated event types, thread preservation, and reply failures.

**Review checkpoint:** a test Chat space receives a threaded response and an escalation response without
exposing management controls.

## Phase 9 — Multi-channel hardening

Verify channel-specific dashboard dimensions, cross-channel correlation, external delivery retry/dead
letter behavior, rate limits, retention, incident runbooks, and permission boundaries. Run end-to-end
smoke tests for web, email, and Google Chat, then deploy and tear down the complete installation.
