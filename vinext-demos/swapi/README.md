# SWAPI Explorer (Vinext)

A read-only React explorer and GraphQL API over the canonical Star Wars dataset, deployed to
`https://vinext-swapi.${CLOUDFLARE_DOMAIN}`. It combines Vinext's App Router, a client-rendered
React interface, a Pothos schema and GraphiQL, a four-tier Worker over D1, and Cloudflare Access.

The hostname root serves the explorer: select a collection, open a record, and follow its people,
worlds, species, ships, vehicles, and films. GraphiQL remains available at `/graphql` for people who
want to write queries directly. The experience follows
[`cf-terraform-demos/swapi/docs/UISPEC.md`](../../cf-terraform-demos/swapi/docs/UISPEC.md).

## What this demo teaches

**A browser using a GraphQL API over a relational store without the N+1 problem.** The explorer is
intentionally not server-rendered: the Vinext page renders the client shell, and the browser then
calls same-origin `POST /graphql`. This keeps the network exchange visible and makes the API — not
server-component data access — the demonstration.

The dataset is deeply interconnected. Resolved naively,
`films { characters { homeworld { name } } }` would issue one query for the films, one per film for
its characters, and one per character for the homeworld. Here it costs **three D1 statements**, and
would still cost three over ten times the data:

1. Repository ports in [`src/worker/domain/repositories.ts`](./src/worker/domain/repositories.ts)
   accept sets of identifiers (`findByFilmIds`), never a single one.
2. Request-scoped DataLoaders in
   [`src/worker/application/graphql/types/refs.ts`](./src/worker/application/graphql/types/refs.ts)
   collect keys for each query level and call those ports once per relation.

[`tests/integration/batching.test.ts`](./tests/integration/batching.test.ts) asserts statement
counts directly, so a regression fails the suite rather than merely making the demo slower.

## Architecture

```text
React explorer (Vinext client UI) ─┐
                                  ├─ same-origin POST /graphql ─┐
GraphiQL console (Yoga) ──────────┘                              ▼
                                            Vinext route adapter + Hono Access middleware
                                                                 ▼
                                      Pothos schema + DataLoaders + domain validation
                                                                 ▼
                                                     D1 repository adapters
                                                                 ▼
                                                         Cloudflare D1
```

- **UI:** `app/[[...explorer]]/page.tsx` serves one client-rendered explorer route for `/`,
  `/<type>`, and `/<type>/<id>`. Keeping one mounted tree preserves column state across navigation.
  Focused state, API, domain, and component modules live under [`src/ui/`](./src/ui/).
- **API adapter:** [`app/graphql/route.ts`](./app/graphql/route.ts) and
  [`app/api/me/route.ts`](./app/api/me/route.ts) obtain `env` from `cloudflare:workers` and forward
  untouched requests to the standalone Hono application. They construct no repositories.
- **API:** [`src/worker/routes/graphql.ts`](./src/worker/routes/graphql.ts) mounts GraphQL Yoga and
  logs one structured record per operation. [`src/worker/index.ts`](./src/worker/index.ts) adds
  logging, authentication, identity, and RFC 9457 error shaping.
- **Application/domain:** the Pothos schema depends only on repository ports. Resolvers cannot reach
  `env.DB`.
- **Infrastructure:** [`src/worker/infrastructure/`](./src/worker/infrastructure/) implements those
  ports against D1, with SQL collected in `queries/statements.ts`.

Dependencies point in one direction:

```text
React UI → Vinext route/Hono API → application/domain → D1 infrastructure
```

### Why D1 rather than KV

The application is about relational traversal. The caller chooses the join shape at request time, so
it cannot be precomputed. Batched relations need joins, `IN (...)`, and per-parent window functions;
foreign keys keep the seeded graph honest. KV offers key and prefix reads, not these relational
guarantees.

D1 read replication remains disabled in `infra/vinext-swapi.tf`. It would suit today's immutable
read workload, but the planned editor will require immediate read-after-write visibility.

## Client rendering, not SSR

The App Router is still used, but no Star Wars data is fetched by a server component. The route
component renders `<ExplorerApp />` and stops; all collection, detail, relation, and search requests
originate in the browser through [`src/ui/api/graphql-client.ts`](./src/ui/api/graphql-client.ts).

This is deliberate rather than a limitation:

- the demo visibly teaches the GraphQL request/response flow;
- the same client code handles navigation, loading, retry, and session expiry;
- the empty shell stays fast without preloading all six collections;
- cached immutable records make backward traversal instant.

## Explorer behaviour

The React implementation follows the UI specification:

- three independently scrolling columns under a persistent banner;
- local collection filtering over at most 82 cached rows;
- server-backed global search across all six types in one GraphQL operation;
- grouped attributes, honest text scalars, normalised sentinel values, and preserved opening-crawl
  line breaks;
- collapsible relation panels with visible counts and distinct null/empty messages;
- an addressable traversal path encoded in a compact `trail` query parameter;
- session-lifetime caching for immutable collection and entity data;
- keyboard-operable controls, focus movement after detail replacement, live announcements, semantic
  landmarks/lists, and adequate target sizes;
- responsive three-column, narrowed, and stacked layouts with reduced-motion support.

The UI metadata in [`src/ui/domain/entity-types.ts`](./src/ui/domain/entity-types.ts) drives both
GraphQL documents and rendering, so the requested fields cannot drift from the displayed fields and
the API's asymmetric relation graph is explicit.

## Access and authorization

Two independent controls protect the application:

1. **Edge:** Terraform creates a Cloudflare Access application covering the whole hostname.
2. **In application:** Hono re-validates the Access JWT and checks its `aud` claim against the
   Terraform-published audience. Every Access application in a team shares one JWKS, so signature
   validation alone would accept a token minted for an unrelated application.

The policy list in [`src/access-policies.ts`](./src/access-policies.ts) is shared by deployed
middleware and local Access emulation. `/graphql` and `/api/*` answer an unauthenticated `fetch`
with `401` rather than login-page HTML; page navigations redirect to sign-in. There is no public
route or `/_next/*` bypass because every surface requires authentication.

All authenticated identities read the same fixed dataset. Authentication bounds who may spend a
caller-controlled GraphQL workload; it is not used to filter content.

## Bounding query cost

| Limit                     | Where                                       | What it bounds                        |
| ------------------------- | ------------------------------------------- | ------------------------------------- |
| `first`, 1–100 per parent | `src/worker/domain/relation-limit.ts`       | Rows one relation field returns       |
| Depth 10, breadth 50      | `src/worker/application/graphql/builder.ts` | Operation shape before data is read   |
| Batch size 90             | `src/worker/infrastructure/queries/sql.ts`  | Parameters bound to one D1 statement  |
| Search length 100         | `src/worker/domain/search-term.ts`          | Human-entered collection search input |

Search filtering happens in SQL with bound parameters. Leading-wildcard substring matching cannot
use a normal index; at roughly 260 rows, a simple scan is deliberately clearer and more correct than
adding FTS machinery.

## Observability

Every executed GraphQL operation logs its name, duration, and **D1 statement count**. Query text and
variables are never logged. The count comes from a request-scoped proxy around the D1 binding, so no
repository carries instrumentation and no future statement can forget to be counted.

## Prerequisites

- Node.js 24+ and pnpm 12+.
- Terraform 1.10+.
- A Cloudflare account with an active zone and a Zero Trust team with an identity provider.
- The repository-root `.env`, created with `pnpm create-env`. See
  [`.env.example`](../../.env.example) for the exact token permissions.

Install from the repository root:

```sh
pnpm install
```

## Commands

| Command         | What it does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| `pnpm start`    | Apply local migrations, then run `cf dev` against local simulations.      |
| `pnpm check`    | Types, Oxfmt, Oxlint, and Terraform validation; never writes files.       |
| `pnpm fix`      | Apply formatting, safe lint fixes, and Terraform formatting.              |
| `pnpm test`     | React, Worker unit, and Workers-runtime integration tests; fully offline. |
| `pnpm deploy`   | Provision infrastructure, migrate, build, and upload the Worker.          |
| `pnpm teardown` | Delete the Worker, then destroy its infrastructure.                       |

## Local development

```sh
pnpm start
```

Open <http://localhost:5173>. Local development emulates Cloudflare Access rather than disabling it;
choose either offered identity. Both see the same data.

`pnpm start` applies migrations first. The migration helper addresses D1 by database ID, and
`cloudflare.config.ts` binds that same ID, so `cf dev` reads the exact database the helper migrated.
Local state lives in `.cloudflare/state`; delete it to reset the database.

### Verify locally

After changing the request path:

1. Open the root and select a collection; confirm `POST /graphql` returns rows.
2. Open a record and follow a relation; confirm the collection and URL change together.
3. Open `/graphql`, run the prefilled query, and confirm a single-digit `statementCount` in logs.

The browser check catches runtime integration problems that isolated tests cannot, including a
GraphQL Yoga ponyfill returning a non-native `Response`. `routes/graphql.ts` explicitly gives Yoga
the runtime's fetch globals to avoid that failure.

## Seed data

The dataset is committed as literal SQL in three seed migrations rather than fetched during deploy,
so local development, tests, and deployment are reproducible and offline. Primary keys are
deterministic UUIDv5 values derived from canonical `swapi.info` URLs.

`pnpm generate:seed` regenerates the seed only when the upstream dataset changes. It is not part of
deployment. The seed is split because D1 applies a migration as a unit and rejects an oversized one;
the files are ordered by foreign-key dependencies.

## Deployment lifecycle

```sh
pnpm deploy
```

Terraform provisions the Worker registration, D1 database, custom hostname, and Access application,
then writes `infra/outputs.json`. Remote migrations run before Vite builds and
`cf deploy --prebuilt` uploads the Vinext Worker. Terraform owns infrastructure; `cf` owns
application code.

```sh
pnpm teardown
```

The Worker is deleted **before** Terraform destroys infrastructure so its deployment-managed D1
binding cannot prevent database deletion.

## Testing

The suite covers three levels:

- **React/UI:** visible filtering, selection, relation states, focus, accessibility, global search,
  URL trails, session expiry, retry, and the complete traversal flow.
- **Worker unit:** SQL construction, repositories, domain validation, request context, schema shape,
  and Access policies.
- **Workers runtime:** real migrated D1, authorization outcomes, GraphQL execution, search, relation
  traversal, complexity limits, and bounded statement counts.

`graphql` is pinned to 16.14.2 and aliased to its CommonJS entry in Node tests. Without the alias,
Vite-transformed code and externalized Pothos load two copies; GraphQL's `instanceof` schema checks
then reject a valid schema built by the other copy.

## Trade-offs

- **Every scalar is a GraphQL `String`**, including numeric-looking values. Upstream uses
  `"unknown"`, `"n/a"`, and `"none"` in those positions, so numeric types would invent or discard
  information.
- **No top-level pagination.** The largest fixed collection has 82 rows; pagination and
  virtualization would add machinery the data does not justify.
- **Introspection and GraphiQL remain enabled in production.** The schema is read-only, every
  surface requires Access, and the console is part of what this demo teaches.
- **Static complexity limits bound shape, not total rows.** Per-relation SQL limits cover the row
  axis; a larger public API would also want field-level cost scoring.
- **Session caching assumes immutable data.** The planned editor must add invalidation rather than
  inheriting that assumption unchanged.
