# Todo

A four-tier personal task-list demonstration deployed to Cloudflare Workers at
[`todo.cfapps.uk`](https://todo.cfapps.uk) (when the repository-root `.env` has
`CLOUDFLARE_DOMAIN="cfapps.uk"`). It combines a Vue UI, a Hono API, an application service, and a D1
repository, with every task private to the signed-in Cloudflare Access identity.

## What this demo teaches

Every user's tasks live in **one** `todos` table, separated only by a `user_id` column. Isolation
comes from the SQL predicate in every query — not from separate storage per user — which is how a
real multi-tenant application behaves. The repository is the single place that enforces it, and a
unit test asserts that _every_ statement it issues constrains `user_id`.

It also shows Cloudflare Access used as defence in depth rather than as a single gate: the edge
Access application authenticates the user, and the Worker independently re-validates the JWT **and**
its audience. See [Access and authorization](#access-and-authorization).

## Architecture

```text
Vue UI (presentation)
        │ same-origin JSON API
        ▼
Hono routes + Access middleware (delivery)
        ▼
TodoService + domain validation (application/domain)
        ▼
D1TodoRepository (infrastructure)
        ▼
Cloudflare D1
```

- **UI:** Vue 3, Pinia, and Vuetify render the task list at `/`.
- **API:** Hono exposes `/api/todos` and `/api/me`. There is no public route — every path requires a
  verified identity.
- **Application/domain:** `TodoService` owns the use cases and depends only on the `TodoRepository`
  port. Validation lives in the domain so every transport enforces the same rules.
- **Infrastructure:** `D1TodoRepository` implements that port against D1.

Dependencies point one way only. `src/worker/index.ts` is the single composition root that knows
both the service and the concrete repository; route handlers never construct a repository.

### Why D1 rather than KV

The sibling [`link`](../link) demo uses Workers KV. This one uses D1 because task lists need things
KV cannot provide:

- a relational predicate (`WHERE user_id = ?`) evaluated server-side, rather than key-prefix
  lookups;
- read-your-writes consistency, so a user sees a task immediately after creating it;
- a schema-level `CHECK` constraint keeping `completed` to exactly `0`/`1`.

Read replication is deliberately disabled in `infra/todo.tf` for that consistency reason.

## Access and authorization

Two independent controls protect the API, and **both** are required:

1. **Edge:** a Cloudflare Access application covers the whole hostname with an `allow` policy that
   admits any identity from the team's identity providers. Note `everyone` inside an `allow`
   decision still requires a completed login — it is not a `bypass`.
2. **In-Worker:** `cloudflareAccess` re-validates the JWT and checks its `aud` claim against the
   Access application's Audience tag, which Terraform publishes as the `access_aud` output.

The audience check is the part that matters most. Every Access application in a Cloudflare Access
team shares one JWKS, so signature validation alone would also accept a token minted for an
unrelated application in the same team. An integration test asserts that such a token is rejected.

Because any authenticated identity is a legitimate user here, there is no administrator allowlist
(unlike `link`). The authorization boundary that matters is per-row ownership, and the owner is
always read from the verified JWT via `src/worker/routes/identity.ts` — never from a request
parameter.

## Local database migrations

Migrations are applied by the shared [`scripts/d1-migrate.ts`](../../scripts/d1-migrate.ts) helper
at the repository root, because the logic is identical for any D1-backed demo:

```bash
pnpm migrate:local    # local simulation, ID from infra/local-outputs.json
pnpm migrate:remote   # real database, ID from infra/outputs.json
```

`pnpm start` runs `migrate:local` before `cf dev`, so a fresh clone gets a migrated database
automatically.

Three details about `cf d1 migrations apply` are worth knowing, as all three were verified against
`cf@1.0.0-beta.5` rather than assumed:

- **It requires a database ID, not a name.** Passing a database or binding name fails with
  `Expected a D1 database ID`. The ID is not known until Terraform creates the database, which is
  why a script reads it from the Terraform outputs instead of a hard-coded npm script.
- **`--persist-to` is specified explicitly.** Without it, `cf` writes the local simulation to an
  OS-specific user directory — on macOS `~/Library/Preferences/cloudflare/state`, which does not
  match the `~/.config/cloudflare/state` default the `--help` output advertises. Both
  `migrate:local` and `cf dev` pin it to this demo's `.cloudflare/state` so local data stays inside
  the project.
- **The local binding is pinned by ID too.** The local D1 simulation keys its SQLite file by
  database ID, so `cloudflare.config.ts` binds the same fixed placeholder UUID that `migrate:local`
  passes. That is what makes `cf dev` read the schema the migration created.

Migrations apply cleanly to a completely cold state — **before `cf dev` has ever run** — and are
idempotent: a second run reports no pending migrations. Delete `.cloudflare/state` to reset the
local database.

Integration tests do **not** use the CLI. The Workers pool creates its own isolated D1 database per
run, so `tests/integration/vitest.config.ts` reads the migrations with `readD1Migrations` and the
suite applies them with `applyD1Migrations`. The real migration SQL is therefore exercised by the
test suite, and a broken migration fails `pnpm test` rather than only failing a deploy.

## Prerequisites

- Node.js 24 or later
- pnpm 12 or later
- Terraform 1.10 or later
- A Cloudflare account, a Cloudflare-hosted zone, and a configured Cloudflare Zero Trust team with
  at least one enabled identity provider
- The repository-root [`.env`](../../.env) created with `pnpm create-env`

The API token in the root `.env` needs:

- **Account:** Workers Scripts — Edit; D1 — Edit; Access — Edit; Access: Identity Providers — Read
- **Zone:** DNS — Edit

The demo uses the central environment file — there is no `.env` inside this directory. Terraform
derives the Worker name, database name, and hostname from its fixed demo name: `todo`, `todo-db`,
and `todo.${CLOUDFLARE_DOMAIN}`.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd cf-terraform-demos/todo
pnpm start
```

This applies the D1 migration locally and starts the Cloudflare/Vite development environment. No
`.dev.vars` file is required or tracked: the absence of `ENVIRONMENT` deliberately selects the
toolkit's development logging defaults, while production binds `ENVIRONMENT=production`.

The local Cloudflare Access emulator offers two identities, **Alice** (`alice@example.com`) and
**Bob** (`bob@example.com`). Sign in as one, add some tasks, then use **Sign out** and sign in as
the other to see that the lists are completely separate — the behaviour this demo exists to show.

## Quality checks

```bash
pnpm check          # TypeScript, Oxfmt, Oxlint + tsgolint, Terraform validation/format
pnpm fix            # Apply Oxfmt, safe Oxlint fixes, and Terraform formatting
pnpm test           # All unit, UI, and Workers-runtime integration tests
pnpm test:coverage  # All tests with coverage
pnpm build          # Local-mode Vite/Worker build
```

`cf workers types --mode development` generates `.cloudflare/types/index.d.ts` directly from
`cloudflare.config.ts`. The `check:types` script runs it before TypeScript, so no handwritten or
committed binding-types file is needed.

## Deploy

```bash
pnpm deploy
```

The command:

1. initializes and applies Terraform to create the Worker registration, D1 database, custom
   hostname, and Cloudflare Access application/policy;
2. writes live Terraform outputs to the ignored `infra/outputs.json`;
3. applies D1 migrations to the real database using the ID from those outputs;
4. builds the Vue assets and Worker with those resource IDs; and
5. uploads the prebuilt Worker.

Afterward, visit `https://todo.${CLOUDFLARE_DOMAIN}`, authenticate, and add a task. To see the
isolation, sign out and sign back in as a different identity, then query the database in the
dashboard:

```sql
SELECT id, user_id, title, completed FROM todos ORDER BY created_at DESC;
```

Both users' rows sit in the same table, distinguished only by `user_id`.

## Teardown

```bash
pnpm teardown
```

This first deletes the deployed Worker with `cf workers delete`, removing deploy-managed D1
bindings, then runs `terraform destroy` to remove the Worker registration, D1 database, custom
domain, and Access configuration. The explicit `depends_on` in `infra/todo.tf` forces that ordering,
because Cloudflare refuses to delete a database still bound to a live Worker.
