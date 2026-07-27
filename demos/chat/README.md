# Chat (Enterprise Channel Chat)

An independently deployable Cloudflare Workers, Cloudflare Access, D1, and Durable Objects
demo: a channel-based chat workspace where every signed-in user shares a live conversation
routed to one Durable Object per channel.

> **Status:** Phases 1 and 2 of `docs/04-ENTERPRISE-CHAT.md` are complete. The hostname and
> `/api/*` are now Access-protected, and the `D1`/`CHAT_ROOM` bindings are provisioned. The
> channel directory API, the `ChatRoom` Durable Object's real behavior, and the chat UI arrive
> in Phases 3-5. `src/worker/chat-room/chat-room.ts` currently exports an intentionally empty
> `ChatRoom` class — just enough for the `durable_objects` binding in `wrangler.jsonc.tpl` to
> resolve — so do not expect a working chat experience yet.

## Architecture (current)

```text
Terraform: Worker + custom domain (chat.cfapps.uk) + D1 database + Access application
Access:    any enabled identity provider, required for the whole hostname
Worker:    validates Access JWTs for /api/*; exports the (still-empty) ChatRoom Durable Object
Wrangler:  Worker code deployment, D1 migrations, the CHAT_ROOM Durable Object namespace and
           SQLite migration, static assets
```

Terraform owns the Worker service, the D1 database (the future channel directory only — never
message history), the custom domain, the Access application and policy, and Worker
observability settings (Workers Logs + traces with explicit sampling). Wrangler owns Worker
code versions, D1 schema migrations, the `CHAT_ROOM` Durable Object namespace/migration, and
static asset deployment. The Durable Object namespace needs no separate Terraform resource — it
is created and torn down with the Worker itself.

Later phases add:

- The `channels` D1 schema (seeded with `general` and `random`) and an authenticated
  `/api/channels*` CRUD API any signed-in user can call (Phase 3).
- The real `ChatRoom` Durable Object: a SQLite-backed `messages` table, the hibernatable
  WebSocket upgrade, message validation and broadcast, and a `destroy()` RPC method that purges
  a removed channel's state (Phase 3).
- A channel sidebar, message pane, and composer Vue 3 + Vuetify interface (Phase 4).
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
- A Cloudflare zone for `cfapps.uk` with no conflicting `chat.cfapps.uk` CNAME.
- An API token scoped to the target account and zone with:
  - Account: Workers Scripts - Edit
  - Account: Access: Apps and Policies - Edit
  - Account: D1 - Edit
- A Cloudflare Zero Trust organization with at least one enabled identity provider (any
  provider works — this demo does not restrict which one).

Use a remote, encrypted Terraform state backend for shared or production operation. The
local state files are ignored and must not be committed.

## Configuration

Create the operator environment file:

```sh
cd demos/chat
cp .env.example .env
```

Set every value in `.env`:

- `CLOUDFLARE_API_TOKEN`: API token with the required permissions.
- `CLOUDFLARE_ACCOUNT_ID`: account that owns the Worker, D1 database, and Access application.
- `CLOUDFLARE_ZONE_ID`: zone ID for `cfapps.uk`.
- `DEMO_DOMAIN`: `cfapps.uk`.
- `DEMO_NAME`: `chat`, producing `chat.cfapps.uk`.
- `CLOUDFLARE_TEAM_DOMAIN`: your Zero Trust team domain (for example
  `your-team.cloudflareaccess.com`), used by the Worker to validate Access JWTs.

Do not commit `.env`, Terraform state, the generated `wrangler.jsonc`, or generated binding
types (`worker-configuration.d.ts`).

## Local Development

Install dependencies and start the local Worker/Vite server:

```sh
npm install
npm start
```

`prestart` generates a local `wrangler.jsonc` (fixed placeholder values, no Terraform
required), builds worker binding types, applies any D1 migrations locally, and builds before
`vite dev` starts. D1 and the `CHAT_ROOM` Durable Object both run against Miniflare's local
simulation — no real Cloudflare D1 database or Durable Object namespace is touched locally.

The development-only Access plugin redirects protected paths to its local login page; choose
either `alice@example.com` or `bob@example.com` — the two identities the eventual two-user demo
flow needs. The always-visible **Sign out** control uses `/cdn-cgi/access/logout`, which the
plugin emulates locally and Cloudflare Access serves in production.

## Testing

```sh
npm test              # all Vitest projects (client, worker, integration)
npm run test:unit     # client + worker projects only
npm run test:integration
npm run test:coverage
```

Integration tests run the real Worker (and, once implemented, the real `ChatRoom` Durable
Object) in `workerd` via `@cloudflare/vitest-pool-workers`, against the same generated
`wrangler.jsonc` used for local development. Phase 1/2 tests only cover unauthenticated API
rejection and a verified development token; the full channel/WebSocket workflow follows in
Phase 3.

## Deployment

```sh
cd demos/chat
cp .env.example .env   # fill in real values
npm run deploy
```

`npm run deploy` provisions infrastructure with Terraform, generates `wrangler.jsonc` and
binding types from the live Terraform outputs, applies D1 migrations to the remote database,
builds the client, and deploys the Worker — which also applies the Durable Object migration and
creates the `CHAT_ROOM` namespace.

## Teardown

```sh
npm run teardown
```

`terraform destroy` removes the Worker, the custom domain, the D1 database, and the Access
application/policy — no named or billable resources are left behind. The Durable Object
namespace and all channel state are removed along with the Worker; no separate preteardown step
is needed. `postteardown` removes the generated `wrangler.jsonc` and `worker-configuration.d.ts`.

## Observability

Workers Logs (100% sampling) and traces (10% sampling) are enabled via Terraform on the
`cloudflare_worker` resource. Once the channel and message routes exist (Phase 3), structured
`channel_created`, `channel_removed`, `channel_joined`, `message_posted`, and `channel_left`
log events will be visible in the Cloudflare dashboard under **Workers & Pages → chat → Logs**.

## Troubleshooting

- **`terraform apply` fails with error `100124`** attaching the custom domain: this is
  expected on a truly fresh Worker before the bootstrap deployment exists; re-running
  `npm run deploy:infra:apply` after the bootstrap resources are created resolves it.
- **`wrangler.jsonc` already exists and looks wrong**: delete it and re-run the relevant
  generation step (`npm run generate:wrangler:local` for local development, or
  `npm run generate:wrangler` after a real `terraform apply`).
- **Access sign-in is denied**: confirm the target Zero Trust organization has an enabled login
  method. The deployed application accepts any available identity provider.
- **`wrangler dev`/`vite dev` fails to resolve the `CHAT_ROOM` binding**: confirm
  `src/worker/index.ts` still re-exports `ChatRoom` from `./chat-room/chat-room` — the
  `durable_objects` binding in `wrangler.jsonc.tpl` requires a named export with that exact
  class name from the Worker's main module.
