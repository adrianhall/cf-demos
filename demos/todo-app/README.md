# Tasks (Personalized TODO App)

An independently deployable Cloudflare Workers, Cloudflare Access, and D1 demo: a
per-user TODO list where each authenticated Access identity only ever sees their own
tasks.

> **Status:** Phases 1 and 2 of `docs/02-TODO-APP.md` are complete. Cloudflare Access gates
> the hostname and API, while the D1-backed `/api/todos` workflow and TodoMVC-style UI arrive
> in later phases.

## Architecture (current)

```text
Terraform: Worker + custom domain (tasks.cfapps.uk) + D1 database + Access application
Access:    any enabled identity provider at the hostname edge
Worker:    validates Access JWTs for /api/*
Wrangler:  Worker code deployment, D1 migrations, static assets
```

Terraform owns the Worker service, D1 database, custom domain, Access application and policy,
and Worker observability settings (Workers Logs + traces with explicit sampling). Wrangler owns
Worker code versions, D1 schema migrations, and static asset deployment. Access protects every
page at the edge and `cloudflareAccess()` independently validates `/api/*` JWTs before routes
can use the verified identity email.

Later phases add:
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
The development-only Access plugin redirects protected paths to its local login page; choose
either `alice@example.com` or `bob@example.com`. The always-visible **Sign out** control uses
`/cdn-cgi/access/logout`, which the plugin emulates locally and Cloudflare Access serves in
production.

## Testing

```sh
npm test              # all Vitest projects (client, worker, integration)
npm run test:unit     # client + worker projects only
npm run test:integration
npm run test:coverage
```

Integration tests run the real Worker in `workerd` via
`@cloudflare/vitest-pool-workers`, against the same generated `wrangler.jsonc` used for
local development. They cover unauthenticated API rejection and a verified development token;
the full TODO workflow follows in Phase 3.

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
- **Access sign-in is denied**: confirm the target Zero Trust organization has an enabled login
  method. The deployed application accepts any available identity provider; lock it down with a
  more specific Access policy if required.
