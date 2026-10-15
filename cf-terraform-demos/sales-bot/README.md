# SalesBot

SalesBot is an authenticated Vue and Cloudflare Workers foundation for the internal Cloudflare-sales
demonstration. Phase 1 provides the Access-protected shell, verified `/api/me` identity, D1 schema,
Terraform-owned infrastructure, and safe RFC 9457 API errors. Chat, knowledge, and management
workflows are added in later phases.

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
