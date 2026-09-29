# Link (Vinext)

A four-tier URL-shortener demonstration deployed to Cloudflare Workers at
[`vinext-link.example.com`](https://vinext-link.example.com) (when the repository-root `.env` has
`CLOUDFLARE_DOMAIN="example.com"`). based on Vinext/React.

## Architecture

```text
React UI (Vinext presentation)
        │ same-origin JSON API
        ▼
Vinext route handlers + Hono Access middleware (delivery)
        ▼
LinkService + domain validation (application/domain)
        ▼
KvLinkRepository (infrastructure)
        ▼
Workers KV
```

- **UI:** Vinext serves an Access-protected React administrative page at `/admin`.
- **API:** Vinext route handlers adapt `/api/links`, `/api/me`, and public `/l/:code` requests to
  the existing Hono application.
- **Application/domain:** `LinkService` owns use cases and validation while depending only on the
  `LinkRepository` port.
- **Infrastructure:** `KvLinkRepository` uses Workers KV metadata for an efficient administrative
  list.

Public redirects return a temporary `302` with `Cache-Control: no-store`. Workers KV is eventually
consistent and does not provide atomic conditional writes; use D1 or Durable Objects when globally
immediate reads or transactional uniqueness are required.

## Prerequisites

- Node.js 26 or later
- pnpm 12.6 or later
- Terraform 1.10 or later
- A Cloudflare account, Cloudflare-hosted zone, and configured Cloudflare Zero Trust team
- The repository-root [`.env`](../../.env) created with `pnpm create-env`

The API token needs **Workers Scripts — Edit**, **Workers KV Storage — Edit**, **Access — Edit**,
**Access: Identity Providers — Read**, and **DNS — Edit**. This demo uses no local `.env` or
`.dev.vars` file.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd vinext-demos/link
pnpm start
```

`pnpm start` runs `cf dev`, which reads the committed local Terraform-output fixture through
`cloudflare.config.ts` and starts Vinext with local Workers KV storage. No live Terraform state,
per-demo `.env`, `.dev.vars`, or Wrangler configuration is used. The local Cloudflare Access
emulator offers the **Administrator** identity (`admin@example.com`). Open the displayed URL, sign
in as that identity, and manage links at `/admin`.

## Quality checks

```bash
pnpm check          # TypeScript, Oxfmt, Oxlint + tsgolint, Terraform validation/format
pnpm fix            # Apply Oxfmt, safe Oxlint fixes, and Terraform formatting
pnpm test           # UI, unit, and Workers-runtime integration tests
pnpm test:coverage  # Tests with V8 coverage
pnpm build          # Production Vinext build
```

## Deploy

```bash
pnpm deploy
```

Deployment first provisions the Terraform-owned Worker registration, KV namespace, hostname, and
Access applications. It then writes live Terraform outputs to the ignored `infra/outputs.json`,
builds Vinext through Vite in production mode, and uploads the prebuilt Worker with `cf deploy`.
`cloudflare.config.ts` consumes those outputs so the deployed bindings match the infrastructure
Terraform provisioned.

Visit `https://vinext-link.${CLOUDFLARE_DOMAIN}/admin`, authenticate as `ADMIN_EMAIL`, create a
link, and open `/l/:code`. The redirect stays public; administrative UI and APIs require Cloudflare
Access and an in-application exact-email authorization check.

## Teardown

```bash
pnpm teardown
```

The script deletes the deployed Worker before Terraform destroys the Worker registration, KV
namespace, hostname, and Access controls.
