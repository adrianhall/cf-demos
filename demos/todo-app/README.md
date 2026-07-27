# Tasks (Personalized TODO App)

An independently deployable Cloudflare Workers, Cloudflare Access, and D1 demo: a
per-user TODO list where each authenticated Access identity only ever sees their own
tasks.

> **Status:** Phase 1 of `docs/02-TODO-APP.md` only — infrastructure scaffold and shared
> tooling. Cloudflare Access enforcement, the `/api/todos` API, the D1 schema, and the
> TodoMVC-style UI are not implemented yet. This document will be expanded as later
> phases land; do not expect a working demo experience from the instructions below yet.

## Architecture (current)

```text
Terraform: Worker + custom domain (tasks.cfapps.uk) + D1 database
Wrangler:  Worker code deployment, D1 migrations, static assets
```

Terraform owns the Worker service, the D1 database, the custom domain, and Worker
observability settings (Workers Logs + traces with explicit sampling). Wrangler owns
Worker code versions, D1 schema migrations, and static asset deployment.

Later phases add:

- A Cloudflare Access self-hosted application requiring authentication for the whole
  hostname (Phase 2).
- The `todos` D1 schema and an authenticated `/api/todos` CRUD API scoped to the
  verified Access identity (Phase 3).
- A TodoMVC-style Vue 3 + Vuetify interface (Phase 4).
- Full test coverage and final documentation (Phase 5).

This demo uses one Wrangler configuration file, generated in two different ways:

- `wrangler.jsonc.tpl`: committed template with `{{placeholder}}` markers.
- `wrangler.jsonc`: gitignored, generated either from hardcoded local values
  (`scripts/generate-local-wrangler.js`, used by `dev`/`build`/`check:types`) or from live
  Terraform outputs (`generate-wrangler`, used by `npm run deploy`). Only one of these ever
  runs against a given checkout at a time — the local script is a no-op once a real
  `wrangler.jsonc` exists.

## Prerequisites

- Node.js 24 or newer and npm 11 or newer.
- Terraform 1.10 or newer.
- A Cloudflare zone for `cfapps.uk` with no conflicting `tasks.cfapps.uk` CNAME.
- An API token scoped to the target account and zone with:
  - Account: Workers Scripts - Edit
  - Account: Access: Apps and Policies - Edit
  - Account: D1 - Edit

Use a remote, encrypted Terraform state backend for shared or production operation. The
local state files are ignored and must not be committed.

## Configuration

Create the operator environment file:

```sh
cd demos/todo-app
cp .env.example .env
```

Set every value in `.env`:

- `CLOUDFLARE_API_TOKEN`: API token with the required permissions.
- `CLOUDFLARE_ACCOUNT_ID`: account that owns the Worker, D1 database, and Access
  applications.
- `CLOUDFLARE_ZONE_ID`: zone ID for `cfapps.uk`.
- `DEMO_DOMAIN`: `cfapps.uk`.
- `DEMO_NAME`: `tasks`, producing `tasks.cfapps.uk`.

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated
binding types (`worker-configuration.d.ts`).

## Local Development

Install dependencies and start the local Worker/Vite server:

```sh
npm install
npm start
```

`prestart` generates a local `wrangler.jsonc` (fixed placeholder values, no Terraform
required) and builds worker binding types before `vite dev` starts. D1 runs against
Miniflare's local SQLite simulation — no real Cloudflare D1 database is touched locally.

## Testing

```sh
npm test              # all Vitest projects (client, worker, integration)
npm run test:unit     # client + worker projects only
npm run test:integration
npm run test:coverage
```

Integration tests run the real Worker in `workerd` via
`@cloudflare/vitest-pool-workers`, against the same generated `wrangler.jsonc` used for
local development.

## Deployment

```sh
cd demos/todo-app
cp .env.example .env   # fill in real values
npm run deploy
```

`npm run deploy` provisions infrastructure with Terraform, generates `wrangler.jsonc`
and binding types from the live Terraform outputs, applies D1 migrations to the remote
database, builds the client, and deploys the Worker.

## Teardown

```sh
npm run teardown
```

`terraform destroy` removes the Worker, the custom domain, and the D1 database — no
named or billable resources are left behind. `postteardown` removes the generated
`wrangler.jsonc` and `worker-configuration.d.ts`.

## Observability

Workers Logs (100% sampling) and traces (10% sampling) are enabled via Terraform on the
`cloudflare_worker` resource. Once the Worker has routes (Phase 3), structured log events
will be visible in the Cloudflare dashboard under **Workers & Pages → tasks → Logs**.

## Troubleshooting

- **`terraform apply` fails with error `100124`** attaching the custom domain: this is
  expected on a truly fresh Worker before the bootstrap deployment exists; re-running
  `npm run deploy:infra:apply` after the bootstrap resources are created resolves it.
- **`wrangler.jsonc` already exists and looks wrong**: delete it and re-run the relevant
  generation step (`npm run generate:wrangler:local` for local development, or
  `npm run generate:wrangler` after a real `terraform apply`).
