# SWAPI Explorer

A read-only explorer and GraphQL API over the canonical Star Wars dataset, deployed to Cloudflare
Workers at [`swapi.cfapps.uk`](https://swapi.cfapps.uk) (when the repository-root `.env` has
`CLOUDFLARE_DOMAIN="cfapps.uk"`). It pairs a Vue 3 + Vuetify + Pinia explorer with a Pothos-built
schema, GraphiQL, a four-tier Worker over D1, and Cloudflare Access.

The hostname root serves the explorer: select a collection, open a record, and follow its people,
worlds, species, ships, vehicles, and films. GraphiQL remains available at [`/graphql`](./graphql)
for people who want to write queries directly. The experience is specified in
[`docs/UISPEC.md`](./docs/UISPEC.md).

## What this demo teaches

**A GraphQL API over a relational store without the N+1 problem.** The dataset is deeply
interconnected — films to characters, characters to homeworlds and species, both to the starships
and vehicles they pilot — and a GraphQL caller composes the traversal at request time. Resolved
naively, `films { characters { homeworld { name } } }` issues one query for the films, one per film
for its characters, and one per character for the homeworld: well over a hundred round trips to D1.

Here it costs **three statements**, and would still cost three over ten times the data. Two design
decisions produce that, and both are structural rather than a matter of care:

1. Every repository port in
   [`src/worker/domain/repositories.ts`](./src/worker/domain/repositories.ts) accepts a **set** of
   identifiers (`findByFilmIds`), never a single one. The application tier is therefore unable to
   express a per-row fetch.
2. Request-scoped DataLoaders in
   [`src/worker/application/graphql/types/refs.ts`](./src/worker/application/graphql/types/refs.ts)
   collect the keys for each level of the query and call those ports once per relation.

[`tests/integration/batching.test.ts`](./tests/integration/batching.test.ts) asserts the statement
counts directly, so a regression fails the suite rather than merely making the demo slower.

It also shows **bounding a caller-controlled workload**: per-parent row limits pushed into SQL,
query depth and breadth limits, and per-request statement counting surfaced in the logs.

## Architecture

```text
Vue explorer (assets) ─────┐
                            ├─ same-origin POST /graphql ─┐
GraphiQL console (Yoga) ───┘                               ▼
                                              Hono routes + Access middleware (delivery)
                                                               ▼
                                      Pothos schema + DataLoaders + domain validation (application/domain)
                                                               ▼
                                                     D1 repositories (infrastructure)
                                                               ▼
                                                         Cloudflare D1
```

- **UI:** [`src/client/`](./src/client/) is a Vue 3 + Vuetify + Pinia single-page explorer. The
  asset store serves pages (including deep links), while `runWorkerFirst` reserves `/graphql*` and
  `/api/*` for Worker code. The three fixed columns — navigation, collection, detail — are driven
  from one metadata model in
  [`src/client/domain/entity-types.ts`](./src/client/domain/entity-types.ts), so the UI reflects the
  API's genuinely asymmetric relation graph rather than pretending every type connects to every
  other type. The default semantic theme is dark; light is defined alongside it so a future
  dark/light/system control does not need a redesign.
- **API:** [`src/worker/routes/graphql.ts`](./src/worker/routes/graphql.ts) mounts Yoga and logs one
  structured record per operation. [`src/worker/index.ts`](./src/worker/index.ts) adds logging,
  authentication, the identity endpoint the banner uses, and RFC 9457 error shaping.
- **Application/domain:** the Pothos schema under
  [`src/worker/application/graphql/`](./src/worker/application/graphql/) depends only on the
  repository **ports** in [`src/worker/domain/`](./src/worker/domain/). Resolvers receive those
  ports through the GraphQL context and cannot reach `env.DB` at all.
- **Infrastructure:**
  [`src/worker/infrastructure/d1-repositories.ts`](./src/worker/infrastructure/d1-repositories.ts)
  implements the ports against D1, with all SQL collected in
  [`queries/statements.ts`](./src/worker/infrastructure/queries/statements.ts).

Dependencies point one way only.
[`src/worker/application/request-context.ts`](./src/worker/application/request-context.ts) is the
composition root, and it runs **per request** rather than per isolate — the statement counter and
the DataLoader caches are both request-scoped, so one caller's loaded entities are never served to
another.

### Why D1 rather than KV

The sibling [`link`](../link) demo uses Workers KV. This one uses D1 because the entire point of the
API is relational traversal:

- the query shape is chosen by the caller at request time, so the joins cannot be precomputed;
- resolving a relation for a batch of parents in one statement needs `IN (...)`, a join, and
  `ROW_NUMBER() OVER (PARTITION BY ...)` — a real query engine;
- foreign keys keep the seeded relations honest, which
  [`tests/integration/schema.test.ts`](./tests/integration/schema.test.ts) verifies.

KV can be read by key or key prefix and nothing else, so serving this data from KV would mean
storing a pre-joined blob for every traversal anyone might ever ask for.

Read replication is deliberately disabled in [`infra/swapi.tf`](./infra/swapi.tf). The data is
read-only today, so replica lag would be unobservable and replication would genuinely suit the
workload — but the planned editor introduces writes whose results must be visible in the very next
query, and enabling it now would make that editor's first read-after-write the moment the demo
starts returning stale data.

## Access and authorization

Two independent controls protect the Worker, and **both** are required:

1. **Edge:** a Cloudflare Access application covers the whole hostname with an `allow` policy
   admitting any identity from the team's identity providers. Inside an `allow` decision, `everyone`
   still requires a completed login — unlike the `bypass` decision `link` uses for its public
   surface.
2. **In the Worker:** [`middleware/access.ts`](./src/worker/middleware/access.ts) re-validates the
   JWT **and** checks its `aud` claim against the Terraform-published audience. Every Access
   application in a team shares one JWKS, so signature validation alone would also accept a token
   minted for an unrelated application in the same team. This is what makes edge gating
   non-load-bearing on its own, and
   [`tests/integration/worker.test.ts`](./tests/integration/worker.test.ts) proves it by signing a
   valid token for a different audience and asserting a `401`.

The policy list in [`src/access-policies.ts`](./src/access-policies.ts) is a **single definition**
shared by the deployed middleware and the local development plugin, so local sign-in exercises the
identical audience check rather than a weaker variant. An unmatched path blocks rather than
bypasses, so a future route added without its own policy inherits authentication.

What authentication buys here differs from the sibling demos. This dataset is identical for every
caller, so there is no per-identity boundary as in `todo`, and no administrator allowlist as in
`link`. The login wall bounds **who may spend the endpoint's compute** — relevant because a GraphQL
query's cost is caller-chosen. Query cost itself is bounded separately, below.

## Explorer and search

The explorer's user experience is fully documented in [`docs/UISPEC.md`](./docs/UISPEC.md). Its
implementation follows the specification's design boundaries:

- **Server-side search:** every collection field now accepts an optional `search` argument. The
  domain validates and bounds it in [`search-term.ts`](./src/worker/domain/search-term.ts);
  repositories carry it to D1; and SQL binds it as a case-insensitive substring `LIKE` pattern. `%`,
  `_`, and the escape character are treated literally, so text a person types cannot unexpectedly
  become a wildcard. At 260 rows a leading-wildcard scan is deliberately simpler and more correct
  than adding FTS machinery; the query builder records that trade-off beside the statement.
- **Two searches, two jobs:** collection filtering is instant and local over the active collection
  (at most 82 rows), while global search calls all six server-backed collection fields in one
  GraphQL operation. The global query requests only summary fields and no relations, keeping it
  inside the 50-field complexity budget.
- **Addressable traversal:** collection and entity live in the pathname. The actual graph path is
  encoded in a compact `trail` query parameter, so reload, share, and browser back/forward preserve
  the breadcrumb rather than only the terminal record.
- **Session-safe caching:** the Pinia catalog caches entities for the browser session because this
  dataset is immutable and identical for every authenticated caller. It deliberately does not cache
  global-search terms. The day an editor adds mutations, that cache needs invalidation rather than
  being trusted unchanged.
- **Access expiry:** `/graphql` and `/api/*` deliberately return `401` to `fetch` rather than a
  login-page redirect. The UI recognises expiry separately from a data failure and sends a person
  back to sign-in while preserving their current URL.

## Bounding query cost

Three independent limits, each doing a different job:

| Limit                     | Where                                                                           | What it bounds                        |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| `first`, 1–100 per parent | [`domain/relation-limit.ts`](./src/worker/domain/relation-limit.ts)             | Rows one relation field returns       |
| Depth 10, breadth 50      | [`application/graphql/builder.ts`](./src/worker/application/graphql/builder.ts) | Shape of the operation, at validation |
| Batch size 90             | [`infrastructure/queries/sql.ts`](./src/worker/infrastructure/queries/sql.ts)   | Parameters bound to one D1 statement  |

The depth limit matters because the schema is **cyclic**: `film → characters → films → characters`
is valid GraphQL with no natural end. Complexity limits are evaluated during validation, so an
oversized query is refused before a single row is read.

The `first` argument is pushed down into SQL as a window function rather than applied after
fetching, so `first: 3` reads three rows per film out of the database instead of reading all of them
and discarding the rest. A plain `LIMIT` cannot express this — it would truncate the whole result
set, returning three rows in total rather than three per film.

## Observability

Every executed operation logs one record: the operation name, duration, and **statement count**. The
count is the signal worth watching. A deeply nested query reporting a single-digit count is the
batching working; a count that grows with the dataset is the batching broken. Duration alone would
not distinguish them on data this small.

The counter comes from a `Proxy` around the D1 binding in
[`request-context.ts`](./src/worker/application/request-context.ts), so no repository carries
instrumentation and no future query can forget to be counted. Query text and variables are
deliberately **never** logged: documents routinely embed identifiers and variables can carry
anything.

## Prerequisites

- Node.js 24+ and pnpm 12+.
- Terraform 1.10+.
- A Cloudflare account with an active zone, and a Zero Trust team with at least one configured
  identity provider.
- The repository-root `.env`, created with `pnpm create-env`. See
  [`.env.example`](../../.env.example) for the exact API-token permissions.

Install from the repository root, not this directory:

```sh
pnpm install
```

## Commands

| Command         | What it does                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `pnpm start`    | Apply local migrations, then run `cf dev` against local resource simulations. |
| `pnpm check`    | Types, formatting, lint, and Terraform validation. Never writes files.        |
| `pnpm fix`      | Apply every automated correction.                                             |
| `pnpm test`     | Unit and Workers-runtime suites. Runs fully offline.                          |
| `pnpm deploy`   | Provision infrastructure, migrate, then build and upload the Worker.          |
| `pnpm teardown` | Delete the Worker, then destroy its infrastructure.                           |

## Local development

```sh
pnpm start
```

Then open <http://localhost:5173>. It redirects to GraphiQL, which loads with a demonstration query
already in the editor.

Local development **emulates** Cloudflare Access rather than disabling it, so the authorization path
matches production. You will be asked to sign in; pick either offered identity. Both see the same
data — the second exists because the planned editor will distinguish an administrator from an
ordinary reader, so that split can be demonstrated locally the day it lands.

### Verify locally

Worth doing after changing anything in the GraphQL request path, because two classes of bug in this
demo are invisible to `pnpm test`:

1. Open <http://localhost:5173> and confirm it lands on GraphiQL.
2. Run the pre-filled query and confirm data comes back.
3. Confirm the Worker log for that request reports a single-digit `statementCount`.

Step 2 is not redundant with the test suite. GraphQL Yoga bundles a WHATWG fetch ponyfill and
prefers it unless handed the runtime's globals through `fetchAPI`; a `PonyfillResponse` fails the
Workers runtime's own `instanceof Response` check and **every** request dies with
`the Promise did not resolve to 'Response'`. The Vitest Workers pool resolves Yoga's dependencies
differently from the Vite dev SSR pipeline, so the suite passes while `cf dev` is completely broken.
See the `fetchAPI` comment in [`routes/graphql.ts`](./src/worker/routes/graphql.ts).

### Local database migrations

`pnpm start` runs `migrate:local` first. Migrations are addressed by **database ID**, because
`cf d1 migrations apply` rejects names and binding names outright — so the ID in
[`infra/local-outputs.json`](./infra/local-outputs.json) is the same value
[`cloudflare.config.ts`](./cloudflare.config.ts) binds as `DB`, which is what makes `cf dev` read
the schema those migrations created. Local state lives in `.cloudflare/state`; delete it to reset
the database.

## The seed data

The dataset is committed as literal SQL across three migrations rather than fetched at deploy time.
A migration must produce the same database every time it runs, and a network fetch would make the
schema depend on an upstream repository still being reachable and unchanged. It also lets the tests
and `pnpm start` work fully offline.

Primary keys are deterministic UUIDv5 values derived from each resource's canonical `swapi.info`
URL, so regenerating against unchanged upstream data reproduces the files byte for byte, and an
identifier pasted into a saved query keeps working across rebuilds.

`pnpm generate:seed` regenerates them, which is only needed if the upstream dataset changes. It is
**not** part of deployment.

The split into three files is a real constraint, not organisation: D1 applies a migration as a
single unit and refuses an oversized one. The unsplit ~110 KB seed failed with
`statement too long: SQLITE_TOOBIG` even though no individual statement was close to any limit. The
files are grouped in foreign-key dependency order — planets, species, and characters; then films,
starships, and vehicles; then the join tables — so each is independently valid and the sequence
applies to an empty database. The generator enforces the size ceiling when writing, and
[`tests/worker/infrastructure/sql.test.ts`](./tests/worker/infrastructure/sql.test.ts) asserts it
for what is committed.

## Deploy

```sh
pnpm deploy
```

Terraform provisions the Worker registration, D1 database, custom hostname, and Access application,
then writes `infra/outputs.json`; remote migrations run; then Vite builds and `cf deploy --prebuilt`
uploads. Terraform owns infrastructure and `cf` owns application code — never both.

```sh
pnpm teardown
```

Deletes the Worker **before** destroying infrastructure, so deploy-managed bindings no longer
prevent Terraform from removing the database.

## Testing

145+ tests across three suites:

- **`tests/worker/`** — Node unit tests: SQL construction, row mapping, domain validation, statement
  counting, the policy list, and the built schema's shape.
- **`tests/integration/`** — the real Worker in the Workers runtime against a real migrated D1
  database, covering authorization outcomes, GraphQL execution, relation traversal in both
  directions, cost limits, and schema drift.
- **`tests/integration/batching.test.ts`** — statement counts for nested queries, which is the claim
  this demo exists to make.

Everything runs offline. The integration suite applies the committed migrations inside Miniflare's
own database, so a broken migration fails the suite rather than a deploy.

### A note on `tests/worker/vitest.config.ts`

That project aliases `graphql` to its CommonJS entry. The package ships both a CJS and an ESM entry,
and without the alias one run loads **both**: Vite resolves ESM for transformed code while
`@pothos/core` is externalized and `require`s CJS. The schema is then built from one copy's classes
and asserted against the other's, so `instanceof GraphQLObjectType` is false for a type that
genuinely is one. The deployed Worker is bundled and unaffected.

`graphql` is pinned to `16.14.2` rather than `17.x` for a related reason: v17's `development` export
condition resolves to a separate build, reintroducing the same dual-instance split in a way the
alias does not fix. Pothos and Yoga are both primarily tested against v16. Revisit once their v17
support is better exercised.

## What comes next

A data editor. The browser is now implemented as the three-column explorer described in
[`docs/UISPEC.md`](./docs/UISPEC.md): navigation, collection, and detail, with relation traversal,
server-backed global search, and addressable breadcrumbs. The remaining editor work is anticipated
in the current design rather than bolted on later:

- **Access** — reads stay open to any authenticated identity; writes will get a second, path-scoped
  Access application restricted to `ADMIN_EMAIL`, following the pattern
  [`link`](../link/infra/access.tf) already demonstrates for `/admin*`. Edge gating will not be
  sufficient on its own, so the mutations will need their own authorization check.
- **Schema** — there is no `Mutation` type today, and its absence is visible in the published schema
  rather than discovered from a runtime error.
- **Storage** — `D1Reader` exposes only `prepare`, so these repositories are provably read-only.
  Widening it will be a visible, reviewable change.
- **Config** — the explorer already owns `/` through the asset-store SPA fallback. The Worker runs
  first only for `/graphql*` and `/api/*`; a future editor can therefore add its routes without
  changing host-level routing or displacing GraphiQL.

## Trade-offs

- **Every scalar is a `String`**, including `episodeId`, `mass`, and `diameter`. Upstream uses
  sentinel text like `"unknown"` and `"n/a"` in those positions, so typing them numerically would
  mean inventing values or dropping them. The API reports what the dataset actually contains.
- **Introspection and GraphiQL are enabled in production.** The console is this demo's only user
  interface, the schema is public knowledge, and the whole hostname requires a login. An API with a
  confidential schema or with mutations should reconsider both.
- **Complexity limits are static.** Depth and breadth bound the query _shape_, not the rows it
  returns; a query well within both can still ask for every character. Per-relation `first` limits
  cover that, but a production API with untrusted callers would want field-level cost scoring.
- **No pagination on the top-level list fields.** The dataset is small and fixed, so `films` and
  `people` return everything. A growing dataset would need cursors.
