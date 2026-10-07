# Architect

Architect is a Cloudflare-centric architecture diagram tool: a React Flow canvas backed by a
Cloudflare Worker, D1, Workers KV, Static Assets and Cloudflare Access.

This directory currently contains **Phase 1** of the port: the deployable scaffold, complete
provision/deploy/teardown lifecycle, the original 2,023-line stylesheet, a source-compatible path
selector with temporary views, theme primitives, and a minimal Worker/API baseline. Product features
arrive in the phases documented in
[`../../specs/architect/02-implementation.md`](../../specs/architect/02-implementation.md); the
placeholders here are not re-authored substitutes for those components.

## Why this is a port

The working application is prior art, not a loose inspiration. Client files are copied as whole
units wherever their dependencies permit it, then adapted only at data, Access and configuration
seams. In particular, [`src/client/app.css`](src/client/app.css) is copied verbatim: its tokens,
contrast commentary, responsive breakpoints and print rules are part of the product. A built-output
contract fails `pnpm check` if the brand colour, system font stack, design tokens or native
`light-dark()` semantics drift.

The app deliberately remains a plain React SPA. Links into `/app*` are ordinary document
navigations, which lets Cloudflare Access intercept the request before a protected bundle runs. A
client-side router would resolve the path inside an already-loaded bundle and remove that
interception point.

## Prerequisites

- Node.js 24 or newer
- pnpm 12 or newer
- Terraform 1.10 or newer
- A Cloudflare account with a domain and a configured Zero Trust identity provider
- A repository-root `.env`, created with `pnpm create-env`

The API token permissions are documented in the repository-root
[`.env.example`](../../.env.example). This demo reads no per-demo `.env` and needs no `.dev.vars`.

## Local development

From the repository root:

```sh
pnpm install
cd cf-terraform-demos/architect
pnpm start
```

`pnpm start` applies the committed D1 migrations to the local simulation, then runs `cf dev` with
state persisted under `.cloudflare/state`. It uses only the committed
[`infra/local-outputs.json`](infra/local-outputs.json) fixture: no live Terraform state or cloud
resource is read.

The local Access emulator offers two identities:

- `admin@example.com`, matching the committed local `ADMIN_EMAIL` placeholder;
- `alice@example.com`, an ordinary user.

The current public shell is available at the URL printed by `cf dev`. `/api/health` is deliberately
public; `/api/me` and future management APIs exercise the real Access middleware and audience check.

## Commands

| Command              | Purpose                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm start`         | Apply local D1 migrations, then run the local application and Access emulator.                                                 |
| `pnpm check`         | Generate binding types and verify TypeScript, Oxfmt, Oxlint, naming, built CSS, and Terraform without changing authored files. |
| `pnpm fix`           | Apply Oxfmt, safe Oxlint fixes, and Terraform formatting.                                                                      |
| `pnpm test`          | Run client, Worker, Workers-runtime integration, and built-artifact tests.                                                     |
| `pnpm test:coverage` | Run the suite with Istanbul's 80% statements/branches/functions/lines gates.                                                   |
| `pnpm deploy`        | Apply Terraform, write outputs, migrate remote D1, build, and upload with `cf deploy --prebuilt`.                              |
| `pnpm teardown`      | Resolve and delete this demo's Worker, then destroy Terraform-owned infrastructure.                                            |

Every namespaced step (`check:types`, `deploy:infra`, `migrate:remote`, and so on) is independently
runnable when diagnosing one stage.

## Deployment lifecycle

> **Do not deploy just to test this phase.** Local development and the complete offline test suite
> cover it. The commands below create and remove real resources.

Terraform owns the Worker registration/bootstrap deployment, custom hostname, Access applications,
D1 database and Workers KV namespace. `cf` owns the application code upload and deploy-time
bindings. Neither tool recreates the other's resources.

```text
pnpm deploy
  terraform apply
  → write infra/outputs.json
  → apply remote D1 migrations
  → Vite / Cloudflare build
  → cf deploy --prebuilt

pnpm teardown
  resolve worker_name from Terraform state
  → cf workers delete --force
  → terraform destroy
```

The Worker is deleted first because Cloudflare refuses to delete D1/KV resources still bound to a
live Worker. Terraform also records explicit Worker-to-storage dependency edges, ensuring safe
reverse ordering if the lifecycle is invoked directly.

## Naming and coexistence

This port intentionally coexists with the deployment it was ported from. The Worker name and
hostname are therefore Terraform variables declared in [`infra/providers.tf`](infra/providers.tf),
not literals in scripts or application code. Their initial coexistence values appear only as the
variable defaults in `infra/providers.tf`; downstream consumers never restate them.

Both values flow through documented scalar Terraform outputs into
[`cloudflare.config.ts`](cloudflare.config.ts). Teardown resolves `worker_name` from live Terraform
state rather than writing a name into `package.json`. `pnpm check:naming` scans the demo for
literals that could reach the reference deployment or survive a rename.

To see the effective deployed values after applying Terraform:

```sh
terraform -chdir=infra output -raw worker_name
terraform -chdir=infra output -raw hostname
```

Do not change the variable defaults for cutover until the source-parity checkpoint in the
implementation plan is complete and the previous deployment has released its names.

## Architecture baseline

Dependencies point in one direction:

```text
React UI → Hono routes → application services → domain/ports → infrastructure adapters
```

Phase 1 has no product service yet. [`src/worker/index.ts`](src/worker/index.ts) is already the
composition root: later phases construct D1/KV adapters and services there, then inject those
services into routes. Routes never construct repositories.

The Worker currently exposes:

- `GET /api/health` — public liveness, returning `{ "status": "ok" }`;
- `GET /api/me` — authenticated identity from `@demos/worker-common`.

The shared `@demos/worker-common` Access middleware and `@adrianhall/cloudflare-toolkit` logging,
not-found and RFC 9457 error handlers are used from the first route onward. Production responses
never include stack traces.

## Storage choices

- **D1 is authoritative** for diagrams and the user directory. Read replication is disabled because
  an editor save must be visible to the next read.
- **Workers KV is disposable** and will cache share-token-digest → diagram-id lookups. D1 remains
  authoritative for share lifecycle; losing KV must never lose a share record.
- A later **Durable Object** coordinates live sockets only. It does not keep a second durable graph.

The first migration preserves two deliberate schema decisions: no foreign keys, and no
`users.is_admin` column. The single administrator is operator configuration (`ADMIN_EMAIL`), checked
against a verified Access identity on every administrative request, not mutable database state.

## Visual verification

`pnpm start` serves the real stylesheet locally. Before closing a phase, review the local page at
desktop and narrow widths in system, light and dark schemes. Automated coverage is complementary:

- client tests assert structure and behaviour;
- the built-stylesheet contract asserts the original tokens, brand colour, font stack, responsive
  and print rules;
- the contract reads **built output**, because Vite's default CSS transformation lowers
  `light-dark()` into an OS-media-query polyfill that breaks the in-app scheme override while
  continuing to work in development.

`vite.config.ts` excludes that transformation through `Features.LightDark`, and the contract fails
if it regresses.
