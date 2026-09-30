# Todo (Vinext)

A four-tier personal task-list demonstration deployed to Cloudflare Workers at
`vinext-todo.${CLOUDFLARE_DOMAIN}`. It combines Vinext's React App Router, a Hono API, an
application service, and a D1 repository, with every task private to the signed-in Cloudflare Access
identity.

## What this demo teaches

Every user's tasks live in **one** `todos` table, separated only by a `user_id` column. Isolation
comes from the SQL predicate in every query — not from separate storage per user — which is how a
real multi-tenant application behaves. The repository is the single place that enforces it, and a
unit test asserts that _every_ statement it issues constrains `user_id`.

It also shows how to preserve that four-tier architecture behind Vinext rather than folding storage
and authorization into route handlers: `app/api/**` obtains `env` from `cloudflare:workers` and
forwards the untouched request into a standalone Hono application. The application independently
re-validates the Cloudflare Access JWT **and** its audience before reaching any use case.

## Architecture

```text
React UI (Vinext presentation)
        │ same-origin JSON API
        ▼
Vinext route handlers + Hono Access middleware (delivery)
        ▼
TodoService + domain validation (application/domain)
        ▼
D1TodoRepository (infrastructure)
        ▼
Cloudflare D1
```

- **UI:** Vinext serves the React task page at `/`. `app/layout.tsx` and `app/page.tsx` remain
  server components; only the interactive task list and identity indicator are client components
  under `src/ui/`.
- **API:** Vinext route handlers adapt `/api/todos/**` and `/api/me` requests to the Hono
  application. There is no public route — every path requires a verified identity.
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

Read replication is deliberately disabled in `infra/vinext-todo.tf` for that consistency reason.

## Access and authorization

Two independent controls protect the API, and **both** are required:

1. **Edge:** a Cloudflare Access application covers the whole hostname with an `allow` policy that
   admits any identity from the team's identity providers. Note `everyone` inside an `allow`
   decision still requires a completed login — it is not a `bypass`.
2. **In-application:** the Hono `cloudflareAccess` middleware re-validates the JWT and checks its
   `aud` claim against the Access application's Audience tag, which Terraform publishes as the
   `access_aud` output.

The audience check is the part that matters most. Every Access application in a Cloudflare Access
team shares one JWKS, so signature validation alone would also accept a token minted for an
unrelated application in the same team. An integration test asserts that such a token is rejected.

Because any authenticated identity is a legitimate user here, there is no administrator allowlist
(unlike `link`). The authorization boundary that matters is per-row ownership, and the owner is
always read from the verified JWT via `src/worker/routes/identity.ts` — never from a request
parameter.

The shared policy list in `src/access-policies.ts` contains no public bypass, including for
`/_next/*`. That differs deliberately from the public `link` demo: no document here may render
without authentication, so its client chunks are requested only after the browser has an Access
session. Local development uses the same policies and audience through the toolkit's Vite plugin.

## Local database migrations

Migrations are applied by the shared [`scripts/d1-migrate.ts`](../../scripts/d1-migrate.ts) helper
at the repository root, because the logic is identical for any D1-backed demo:

```bash
pnpm migrate:local    # local simulation, ID from infra/local-outputs.json
pnpm migrate:remote   # real database, ID from infra/outputs.json
```

`pnpm start` runs `migrate:local` before `cf dev`, so a fresh clone gets a migrated database
automatically.

Three details about `cf d1 migrations apply` are important:

- **It requires a database ID, not a name.** The ID is not known until Terraform creates the
  database, which is why the shared script reads it from the same Terraform outputs document that
  `cloudflare.config.ts` uses for the binding.
- **`--persist-to` is specified explicitly.** Both `migrate:local` and `cf dev` pin local state to
  this demo's `.cloudflare/state`, so local data stays inside the project regardless of
  platform-specific CLI defaults.
- **The local binding is pinned by ID too.** The local D1 simulation keys its SQLite file by
  database ID, so `cloudflare.config.ts` binds the same fixed placeholder UUID that `migrate:local`
  passes. That is what makes `cf dev` read the schema the migration created.

Migrations are idempotent: a second run reports no pending migrations. Delete `.cloudflare/state` to
reset the local database.

Integration tests do **not** use the CLI. The Workers pool creates its own isolated D1 database per
run, so `tests/integration/vitest.config.ts` reads migrations with `readD1Migrations` and the suite
applies them with `applyD1Migrations`. The real migration SQL is therefore exercised by `pnpm test`,
and a broken migration fails before deployment.

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

The demo uses the central environment file — there is no `.env` or `.dev.vars` inside this
directory. Terraform derives the Worker name, database name, and hostname from its fixed demo name:
`vinext-todo`, `vinext-todo-db`, and `vinext-todo.${CLOUDFLARE_DOMAIN}`.

## Install

From the repository root:

```bash
pnpm install
```

## Local development

```bash
cd vinext-demos/todo
pnpm start
```

This applies the D1 migration locally and starts Vinext through the `cf`/Vite development
environment. No live Terraform state, per-demo `.env`, `.dev.vars`, Wrangler configuration, or
legacy deployment command is used.

The local Cloudflare Access emulator offers two identities, **Alice** (`alice@example.com`) and
**Bob** (`bob@example.com`). Sign in as one, add tasks, then use **Sign out** and sign in as the
other to see that the lists are completely separate — the behaviour this demo exists to show.

## Quality checks

```bash
pnpm check          # TypeScript, Oxfmt, Oxlint + tsgolint, Terraform validation/format
pnpm fix            # Apply Oxfmt, safe Oxlint fixes, and Terraform formatting
pnpm test           # All unit, React UI, and Workers-runtime integration tests
pnpm test:coverage  # All tests with Istanbul coverage
pnpm build          # Local-mode Vinext/Worker build
```

`cf workers types --mode development` generates `.cloudflare/types/index.d.ts` directly from
`cloudflare.config.ts`. The `check:types` script runs it before TypeScript, so no handwritten or
committed binding-types file is needed.

A build can emit Vinext's informational dynamic-import warnings; a non-zero build exit remains a
failure, but these diagnostics do not prevent deployment.

## Deploy

```bash
pnpm deploy
```

The command:

1. initializes and applies Terraform to create the Worker registration, D1 database, custom
   hostname, and Cloudflare Access application/policy;
2. writes live Terraform outputs to the ignored `infra/outputs.json`;
3. applies D1 migrations to the real database using the ID from those outputs;
4. builds the Vinext application in production mode with those resource IDs; and
5. uploads the prebuilt Worker with `cf deploy --prebuilt`.

Afterward, visit `https://vinext-todo.${CLOUDFLARE_DOMAIN}`, authenticate, and add a task. To see
isolation, sign out and sign back in as a different identity, then query the database in the
Cloudflare dashboard:

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
domain, and Access configuration. The explicit `depends_on` in `infra/vinext-todo.tf` forces that
ordering, because Cloudflare refuses to delete a database still bound to a live Worker.
