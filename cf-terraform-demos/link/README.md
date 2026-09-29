# Link

A four-tier URL-shortener demonstration deployed to Cloudflare Workers at
[`link.example.com`](https://link.example.com) (when the repository-root `.env` has
`CLOUDFLARE_DOMAIN="example.com"`). It combines a Vue administrative UI, Hono API, application
service, and Workers KV repository.

## Architecture

```text
Vue UI (presentation)
        │ same-origin JSON API
        ▼
Hono routes + Access middleware (delivery)
        ▼
LinkService + domain validation (application/domain)
        ▼
KvLinkRepository (infrastructure)
        ▼
Workers KV
```

- **UI:** Vue 3, Pinia, and Vuetify provide a Cloudflare Access-protected `/admin` page.
- **API:** Hono exposes administrative CRUD endpoints at `/api/links` and a public redirect at
  `/l/:code`.
- **Application/domain:** `LinkService` owns use cases and validation while depending only on the
  `LinkRepository` port.
- **Infrastructure:** `KvLinkRepository` implements that port with Workers KV. KV metadata makes the
  small administrative list efficient without one read per link.

Public redirects return a temporary `302` with `Cache-Control: no-store`. Workers KV is eventually
consistent and does not provide atomic conditional writes; it is appropriate here for a small demo,
but use D1 or Durable Objects when globally immediate reads or transactional uniqueness matter.

## Prerequisites

- Node.js 26 or later
- pnpm 12.6 or later
- Terraform 1.10 or later
- A Cloudflare account, a Cloudflare-hosted zone, and a configured Cloudflare Zero Trust team
- The repository-root [`.env`](../../.env) created with `pnpm create-env`

The API token in the root `.env` needs:

- **Account:** Workers Scripts — Edit; Workers KV Storage — Edit; Access — Edit; Access: Identity
  Providers — Read
- **Zone:** DNS — Edit

The demo deliberately uses the central environment file—there is no `.env` inside this directory.
Terraform derives the Worker name and hostname from its fixed demo name: `link` and
`link.${CLOUDFLARE_DOMAIN}`.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd cf-terraform-demos/link
pnpm start
```

`pnpm start` starts the Cloudflare/Vite development environment using local Workers KV storage. No
`.dev.vars` file is required or tracked: the absence of `ENVIRONMENT` deliberately selects the
application toolkit's development logging defaults, while production binds `ENVIRONMENT=production`.
The local Cloudflare Access emulator provides an **Administrator** identity (`admin@example.com`).
Open the local URL shown by the command, sign in as that identity, and manage links at `/admin`.

## Quality checks

```bash
pnpm check          # TypeScript, Oxfmt, Oxlint + tsgolint, Terraform validation/format
pnpm fix            # Apply Oxfmt, safe Oxlint fixes, and Terraform formatting
pnpm format         # Backward-compatible alias for Oxfmt formatting
pnpm test           # All unit, UI, and Workers-runtime integration tests
pnpm test:coverage  # All tests with V8 coverage
pnpm build          # Local-mode Vite/Worker build
```

The demo uses the VoidZero toolchain: Vite, Vitest, Oxfmt, and Oxlint with tsgolint type-aware
rules. It remains on Vitest 4 because the currently released `@cloudflare/vitest-plugin` declares
Vitest 4 peer dependencies; upgrading to Vitest 5 should happen when the Cloudflare plugin supports
it, rather than suppressing a peer mismatch in a demo intended to teach good practices. The app uses
the current Cloudflare Vite-plugin v2 beta required by the `cf` CLI build chain.

`cf workers types --mode development` generates `.cloudflare/types/index.d.ts` directly from
`cloudflare.config.ts`. The `check:types` script runs it before TypeScript, so no handwritten or
committed `worker-configuration.d.ts` file is needed.

## Deploy

```bash
pnpm deploy
```

The command:

1. initializes and applies Terraform to create the Worker registration, KV namespace, custom
   hostname, and Cloudflare Access applications;
2. writes live Terraform outputs to ignored `infra/outputs.json`;
3. builds the Vue assets and Worker with those resource IDs; and
4. uploads the prebuilt Worker.

Afterward, visit `https://link.${CLOUDFLARE_DOMAIN}/admin`, authenticate as `ADMIN_EMAIL`, create a
link, and open its `/l/:code` URL. The public redirect is intentionally reachable without Access;
the administrative page and API require Access plus an in-Worker exact-email authorization check.

## Teardown

```bash
pnpm teardown
```

This first deletes the deployed Worker with `cf delete`, removing deploy-managed KV bindings, then
runs `terraform destroy` to remove the Terraform-managed Worker registration, KV namespace, custom
domain, and Access configuration.
