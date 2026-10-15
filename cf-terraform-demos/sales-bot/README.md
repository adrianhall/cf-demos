# SalesBot

SalesBot is an authenticated Vue and Cloudflare Workers demonstration for internal Cloudflare sales.
Phase 2 adds the FAQ/documentation knowledge base: the supplied product ownership map, audience- and
expiry-aware FAQ revisions, PM scope checks with an administrator override, immutable audit events,
a reviewed Cloudflare documentation manifest, retryable indexing jobs, and an administrator
freshness view. Chat and escalation workflows are added in later phases.

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
