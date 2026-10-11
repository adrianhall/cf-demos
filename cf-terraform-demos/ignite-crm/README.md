# Ignite CRM

A small-business CRM built as **two Cloudflare Workers**: a public Application Worker (Vue SPA +
Hono API) and a private Data Worker (CRM, Projects, Notes, and Permissions modules over one D1
database), connected only by a typed Workers RPC service binding.

The product scope is in
[`specs/ignite-crm/00-introduction.md`](../../specs/ignite-crm/00-introduction.md), the engineering
design in [`01-specification.md`](../../specs/ignite-crm/01-specification.md), and the delivery plan
in [`02-implementation.md`](../../specs/ignite-crm/02-implementation.md). Decisions made during
implementation are recorded in [`03-follow-ons.md`](../../specs/ignite-crm/03-follow-ons.md).

**Current increment: Phase 1** — identity, RBAC, and the first CRM journey (companies and contacts:
create, list, search, view, history).

## Architecture

```text
Browser (Vue 3 + Vuetify SPA)
   │  same-origin HTTPS, Cloudflare Access
   ▼
ignite-crm-application  ── Access JWT verification, same-origin/JSON protections, RFC 9457,
   │                        request ids, shared-schema validation of input AND output
   │  DATA_SERVICE (Workers RPC service binding — the only route to data)
   ▼
ignite-crm-data         ── DataEntrypoint → application services → repository ports → D1 adapter
   │
   ▼
D1 (one database: permissions, CRM, audit, idempotency tables)
```

Four tiers, one direction:
`client → Application API → Data Worker application/domain → infrastructure`.

| Path                             | Tier                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `src/client`                     | UI: Vue SPA, typed API client, Vuetify                     |
| `src/application-worker`         | API: Hono routes, Access, protections, RPC client          |
| `src/data-worker/application`    | Use cases: validation, authorization, idempotency, audit   |
| `src/data-worker/domain`         | Pure rules (no I/O)                                        |
| `src/data-worker/infrastructure` | D1 port and repositories (all SQL lives here)              |
| `src/shared`                     | Runtime-neutral Valibot schemas, RPC contract, error codes |
| `src/configuration.ts`           | Installation settings (UK defaults), validated at start    |

### Why a modular monolith inside one RPC microservice

The Data Worker's modules are structured as if they were separate services (each has its own ports
and use cases), but they share one D1 database and transaction boundary. That keeps the deployment
small and free-tier friendly, and makes cross-module workflows (deal → project conversion,
multi-linked notes) **atomic** instead of a distributed saga. The earlier seven-Worker design is
kept for comparison in `specs/ignite-crm/microservice-experiment/`.

### The RPC contract

`src/shared/data-service/contract.ts` defines the one grouped contract. `DataEntrypoint` exposes
`health`, `resolveActor`, `resolveUser`, `authorize`, and module targets `crm()` and `permissions()`
(methods, not getters, so `env.DATA_SERVICE.crm().getContact(...)` pipelines into one round trip).

Every RPC method resolves to an envelope, `{ ok: true, value } | { ok: false, error }`, rather than
throwing. Expected failures (forbidden, not found, conflict) are ordinary outcomes for a data
service; as values they stay out of the runtime's uncaught-exception logs and their shape does not
depend on RPC error reconstruction. `src/application-worker/data-client.ts` converts the envelope
back into a throwing API and maps transport failures and timeouts to a retryable
`DEPENDENCY_FAILURE` (HTTP 503) whose detail is logged, never returned.

### D1 transactions

D1 has no interactive transactions; `batch()` is atomic but its statements cannot branch on each
other's results. The D1 port (`src/data-worker/infrastructure/d1/d1-port.ts`) models a transaction
as **read, then commit one atomic write set**. Commit-time invariants (expected version, a
referenced row still exists) are queued as **guards**: an `INSERT` into the `tx_guard` view whose
`INSTEAD OF` trigger raises when the precondition is false, aborting and rolling back the whole
batch with a reportable reason. That is compare-and-swap inside the transaction.

### Idempotency and versioning

Every mutation requires `Idempotency-Key`. The same key with the same canonical request returns the
original result (checked **before** the version check, so a retry after a lost response succeeds
even though its `If-Match` is now stale); the same key with a different request is
`409 IDEMPOTENCY_KEY_REUSED`. Records are kept for 24 hours. Updates require `If-Match: "<version>"`
and fail with `409 VERSION_MISMATCH` when stale. Audit events and the idempotency record commit in
the same write set as the business change.

## Security model

- **Cloudflare Access** gates the whole hostname at the edge (any identity in the team's IdPs).
- The Application Worker **re-verifies the Access JWT and its exact audience** on every `/api`
  request (`@demos/worker-common`'s `createAccessMiddleware`). Development tokens are only accepted
  when `import.meta.env.DEV` — statically `false` in production builds.
- Identity is taken **only** from the verified JWT; inbound identity headers are ignored and request
  bodies are `strictObject` schemas, so an `ownerId` cannot be smuggled in.
- **RBAC in the Data Worker**: every use case asks the Permissions module to authorize; the SPA's
  capability hints only hide controls. Permission storage failures fail closed (503, retryable).
- **Bootstrap owner**: the root `.env` `ADMIN_EMAIL` becomes owner on first sign-in. Any other
  Access identity is provisioned as **read-only** on first sign-in.
- Mutations require a same-origin `Origin`/`Sec-Fetch-Site` and an `application/json` body (CSRF
  defence for cookie-borne Access sessions); bodies are limited to 8 KiB.
- The Data Worker has no domain, no workers.dev route, and `fetch()` returns 404.
- All SQL is constant text with bound parameters; search escapes `LIKE` wildcards.
- Errors are RFC 9457 `application/problem+json` with a stable `code`, `requestId`, and `retryable`;
  internal errors never leak detail or stacks in production.

## Prerequisites

- Node 24+, pnpm 12, Terraform ≥ 1.10.
- The repository-root `.env` (`pnpm create-env` at the repository root). See `.env.example` for the
  API-token permissions: D1 Edit, Workers Scripts Edit, Access Edit, and DNS Edit on the zone.

## Commands

Run from this directory after `pnpm install` at the repository root.

| Command         | What it does                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm start`    | `migrate:local` → `seed:local` → `cf dev --persist-to .cloudflare/state`                                                      |
| `pnpm check`    | Types for both Workers, `tsc` (app + Workers-runtime tests), Oxfmt, type-aware Oxlint, Terraform init/validate/fmt, dev build |
| `pnpm fix`      | Regenerate types, Oxfmt write, Oxlint `--fix`, `terraform fmt`                                                                |
| `pnpm test`     | All Vitest projects **with Istanbul coverage** (80% gate on all metrics)                                                      |
| `pnpm deploy`   | Terraform apply → `infra/outputs.json` → remote migrations → production build → deploy Data, then Application                 |
| `pnpm teardown` | Delete Application, then Data Worker, then `terraform destroy`                                                                |

Each step is individually runnable (`pnpm deploy:infra`, `pnpm teardown:worker:data`, …).

### Local development identities

`pnpm start` serves a local Access login page with one identity per seeded role. They exist only in
the local seed (`migrations/seed/9001_local_seed.sql`) — never in a deployed database.

| Identity               | Role                             |
| ---------------------- | -------------------------------- |
| `owner@example.com`    | Owner (also local `admin_email`) |
| `manager@example.com`  | Manager                          |
| `sales@example.com`    | Sales representative             |
| `delivery@example.com` | Delivery contributor             |
| `readonly@example.com` | Read-only                        |

The local seed is shaped as a migration in its own directory because `cf d1 query` has no local
mode; the repository migration helper applies it with `--local` only.

## Tests and coverage

| Project       | Runs in        | Covers                                                                                                    |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `unit`        | Node           | Schemas, domain, use cases over in-memory ports, Hono app over the fake                                   |
| `client`      | jsdom          | API client, views and components with a real `createVuetify()`                                            |
| `contract`    | Node           | Shared Data Worker contract suite against the in-memory fake                                              |
| `integration` | workerd (30 s) | Same contract suite against the real `DataEntrypoint` over RPC + D1, D1 port guards, full system journeys |

The fake Data Worker (`tests/fakes`) composes the **real** application services with in-memory
repositories, and passes the same contract suite as the real one. In the integration project the
Application Worker reaches `DataEntrypoint` through a genuine service binding, so values cross a
real RPC serialization boundary.

Istanbul measures every file under `src/**/*.{ts,vue}`; only tests and declaration files are
excluded. The report is written to `coverage/`.

## Configuration

`src/configuration.ts` holds the installation settings (`GB`, `en-GB`, `Europe/London`, `GBP`, `£`,
medium dates, Monday week start). Edit `DEFAULT_CONFIGURATION` to localise an installation. The SPA
receives only the display DTO from `GET /api/v1/configuration`.

## Vuetify component library

The SPA is built entirely from Vuetify. Components are registered by name in
`src/client/vuetify.ts`, with one light/dark theme as the single source of colour and density. The
palette is built on Cloudflare orange `#FC7C1E` (primary) and `#5A73F4` (secondary). Each has
AA-compliant `*-strong` tones for text and focus, plus `*-container` fills. Phase 1 adds no custom
component exceptions: `ResourceState`, `ContactForm`, and `HistoryList` are compositions of Vuetify
primitives.

## Known limitations (Phase 1)

- Deals, activities, projects, notes, administration, audit viewer, and reports arrive in later
  phases.
- `/mcp` is reserved but has no handler in release one.
- SFC templates are not type-checked: there is no `vue-tsc` compatible with TypeScript 7 (the same
  constraint as the sibling demos). Script logic is covered by DOM tests.
