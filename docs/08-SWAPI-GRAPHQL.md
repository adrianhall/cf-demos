# Demo 8: SWAPI GraphQL Service

Directory: `~/gitlab/cf-demos/demos/swapi-graphql`

Domain: `swapi-graphql.cfapps.uk`

Status: Draft implementation plan

Cloudflare products: Workers and D1.

## Behavior

- Provide a read-only GraphQL API over Star Wars data (SWAPI) — six entity
  types (`Film`, `Person`, `Planet`, `Species`, `Starship`, `Vehicle`) and
  their one-to-many and many-to-many relationships — gated by Cloudflare
  Access authentication (any signed-in identity, no allowlist).
- Serve [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server)'s built-in
  GraphiQL console at `/graphql` as the demo's only interface — there is no
  browser app.
- Resolve relation fields with request-scoped Pothos DataLoaders. N:1 fields
  batch by entity ID; M:N fields batch parent IDs, group rows by parent, and
  support an optional bounded `first` argument using a window function.
- Log one structured record per GraphQL request with the operation name,
  elapsed time, and the number of D1 statements the request issued, so a
  presenter can show that nested relationship queries remain bounded.

## Explicit Exceptions

This demo intentionally narrows the repository-wide baseline in ways that
would be wrong for most other demos. These exceptions control for this demo
only:

- **No in-app authentication.** The hostname is gated by a single Cloudflare
  Access `allow` policy for any authenticated identity (see Access Model),
  but the Worker never verifies the identity JWT or mounts
  `cloudflareAccess()`. The GraphQL API has no per-user data, no mutations,
  and no audit columns, so Access exists only as an edge login wall — a
  visible authentication step for the demo — not an authorization boundary
  the application code enforces.
- **Read-only.** The schema has no `Mutation` type and no write path. Data is
  loaded once via a D1 migration (see Phase 3) and never changes at runtime.
- **No subscriptions.** The `Subscription` type is out of scope.
- **Bounded child lists.** Root lists return the full small reference dataset.
  Relationship fields accept optional `first: Int` values from 1 through 100.
  M:N batching uses `ROW_NUMBER() OVER (PARTITION BY …)` to apply that limit
  independently to every parent.
- **No UI beyond GraphiQL.** GraphQL Yoga's default GraphiQL is enabled
  unconditionally (including in production) because it is the demo's
  intended interface, not a dev convenience to gate behind
  `import.meta.env.DEV`.

## Demo Flow

1. Open `https://swapi-graphql.cfapps.uk/graphql` and sign in through the
   Cloudflare Access login page with any account from the configured
   identity provider — the policy allows any authenticated identity, so
   there is no allowlist to configure. Then run a flat query:

   ```graphql
   { films { title episodeId releaseDate } }
   ```

2. Run a nested query that fans out across a many-to-many join:

   ```graphql
   {
     films {
       title
       characters {
         name
         homeworld { name }
       }
     }
   }
   ```

3. Open Workers Logs and find the structured log for each request. Compare
   `statementCount`: the nested query should stay at three statements (films,
   characters, and homeworlds) regardless of the number of returned rows.
4. Open the D1 console and run `SELECT * FROM film_person LIMIT 10;` to show
   the join table the naive resolver is querying once per film.

## Relevant Skills

- `cloudflare`
- `cloudflare-one`
- `cloudflare-terraform-best-practices`
- `cloudflare-deploy-scripts`
- `cloudflare-toolkit`
- `workers-best-practices`
- `wrangler`

No Vue/browser skills apply — this demo has no client-side application.

## Data Model

Six entity tables, seven join tables, following the canonical SWAPI shape at
<https://github.com/SivaramPg/swapi.info/tree/main/public/api>. Text UUID
primary keys, generated once during seed authoring (not at request time,
since the data never changes).

| Table | Notable columns |
| --- | --- |
| `film` | `episode_id` (unique), `title`, `opening_crawl`, `director`, `producer`, `release_date` |
| `person` | `name`, physical attributes, `homeworld_id → planet` (nullable), `species_id → species` (nullable) |
| `planet` | `name`, `climate`, `terrain`, `population`, … |
| `species` | `name`, `classification`, `designation`, `homeworld_id → planet` (nullable) |
| `starship` | `name`, `model`, `starship_class`, `hyperdrive_rating`, `mglt` |
| `vehicle` | `name`, `model`, `vehicle_class` |

Join tables (many-to-many): `film_person`, `film_planet`, `film_species`,
`film_starship`, `film_vehicle`, `person_starship` (pilots), `person_vehicle`
(pilots).

Source values are stored as `TEXT` even where they look numeric (`height`,
`mass`, `cost_in_credits`, …) because the upstream data uses non-numeric
sentinels (`"unknown"`, `"n/a"`) and thousands separators (`"342,953"`) —
coercing them would require lossy cleanup that adds nothing to the demo.

## GraphQL Schema

Flat `Query` fields only, no arguments beyond `id` lookups:

`films`, `film(id: ID!)`, `people`, `person(id: ID!)`, `planets`,
`planet(id: ID!)`, `speciesList`, `species(id: ID!)`, `starships`,
`starship(id: ID!)`, `vehicles`, `vehicle(id: ID!)`.

Relation fields per type, each resolved with a request-scoped batch query. M:N
fields support an optional `first: Int` argument:

| Type | One-to-many / N:1 | Many-to-many |
| --- | --- | --- |
| `Film` | — | `characters`, `planets`, `species`, `starships`, `vehicles` |
| `Person` | `homeworld`, `species` (nullable) | `films`, `starships`, `vehicles` |
| `Planet` | `residents` | `films` |
| `Species` | `homeworld` (nullable), `people` | `films` |
| `Starship` | — | `pilots`, `films` |
| `Vehicle` | — | `pilots`, `films` |

The schema is cyclic (`Film → Person → Film → …`), which is exactly what
makes the fan-out demonstration interesting and is also why Phase 5 adds
`@pothos/plugin-complexity`'s depth/breadth limit as an operational safety
net for an unauthorized-by-the-application endpoint — that guard is
unrelated to the naive-resolution teaching point and must not batch or
cache anything.

## Access Model

Single Access application over the whole hostname, gated by authentication
rather than left open. One hostname-wide
`cloudflare_zero_trust_access_application` backed by an `allow` policy for
any authenticated identity (`include = [{ everyone = {} }]`) covering `/*`.
This differs from the baseline Public Access bypass pattern in exactly one
place — the policy's `decision` is `"allow"` instead of `"bypass"` — and
needs a configured identity provider in the Cloudflare Zero Trust team, but
no email allowlist and no second, narrower application: every identity that
authenticates through the configured IdP is allowed.

An `allow` policy issues a real Access identity JWT for every request, but
the Worker still never mounts `cloudflareAccess()` or reads that identity —
the GraphQL API has nothing per-user for it to inform. Access's `allow`
policy exists purely as an edge login wall, giving the demo a visible
authentication step without adding any authorization logic to the
application. This does not change the Worker's code at all versus a bypass
policy; only the Terraform `decision` value differs.

## Implementation Plan

### Phase 1 — Scaffold and shared infrastructure

1. Create an independent `demos/swapi-graphql` demo following the canonical
   `demos/url-shortener` layout (`infra/`, `src/worker/`, `tests/integration/`,
   `.env.example`, `README.md`, `DEMO.md`, `EXPLAIN-DEMO.md`), minus
   `src/client/` — there is no browser application.
2. Provision the baseline resources with Terraform: a Worker, the
   `swapi-graphql.cfapps.uk` custom domain (with the one-time inert bootstrap
   version/deployment so `cloudflare_workers_custom_domain` can attach without
   error `100124`), Workers Logs, and automatic tracing with explicit
   sampling. Read all configuration from `../.env` via the `dotenv` provider;
   set `DEMO_NAME=swapi-graphql` and `DEMO_DOMAIN=cfapps.uk`.
3. Provision a D1 database with Terraform and export its binding details as
   Terraform outputs. Terraform owns the database resource; Wrangler owns
   schema migrations.
4. Commit a single `wrangler.jsonc.tpl` with `{{placeholder}}` markers for
   every Terraform-sourced value (Worker name, D1 database id/name), binding
   D1 as `DB`. Add a committed `infra/local-outputs.json` with hardcoded local
   values; wire `generate-wrangler -c -l infra/local-outputs.json` into
   `prebuild`, `prestart`, `precheck:types`, `pretest`, `pretest:coverage`, and
   `pretest:integration`. Generate binding types from `wrangler.jsonc`; never
   hand-maintain the binding interface.
5. Write `.env.example` from the baseline permission block, adding only
   `Account: D1 - Edit`. No `ADMIN_EMAIL` is needed — the Access policy has no
   allowlist — and `CLOUDFLARE_TEAM_DOMAIN` is already part of the baseline
   block, since a team with at least one identity provider configured is a
   deployment prerequisite once the policy requires authentication.

### Phase 2 — Cloudflare Access (authenticate, but don't authorize in-app)

6. Provision exactly one `cloudflare_zero_trust_access_application` covering
   the whole hostname, backed by an `allow` policy for any authenticated
   identity (`include = [{ everyone = {} }]`) instead of the baseline public
   `bypass` policy — see Access Model. Do not add a second, narrower
   application or an email allowlist; this demo has only one path-and-policy
   pair, and every authenticated identity is accepted.
7. Do not add `cloudflareAccess()` to the Worker, and do not configure
   `cloudflareAccessPlugin()` in a Vite config for local dev. Even though
   every production request must now authenticate at the edge, the Worker
   never reads that identity — there is no per-user logic for it to serve —
   and local development still has no Access edge to emulate (this demo
   builds and deploys the Worker directly with `wrangler`, with no
   `vite.config.ts`).

### Phase 3 — Data model and migrations

8. Author `migrations/0001_init.sql`: six entity tables and seven join tables
   per the Data Model above, with `TEXT` UUID primary keys, foreign keys with
   `ON DELETE CASCADE` on the join tables, and one reverse index per join
   table (for example `CREATE INDEX idx_film_person_reverse ON
   film_person(person_id, film_id)`) so both directions of every many-to-many
   relation can use an index. State explicitly in a migration comment that
   these indexes make each naive per-parent query fast individually — they do
   not fix the N+1 *call count*, which is the property this demo exists to
   show.
9. Write a one-time authoring script, `scripts/generate-seed-migration.ts`,
   that fetches the six SWAPI collections from
   `https://raw.githubusercontent.com/SivaramPg/swapi.info/main/public/api/<entity>/<id>.json`,
   resolves each `https://swapi.info/api/<entity>/<id>` reference to a stable
   local UUID, and emits `migrations/0002_seed.sql` as literal `INSERT`
   statements (chunked to stay under D1's 100 KB statement-length limit; the
   100-bound-parameter limit does not apply to literals). Run this script once
   during development and commit its output — it is not part of `npm run
   deploy` or any other routine script, so deploys never depend on GitHub
   availability.
10. Run `wrangler d1 migrations apply DB --local` and `--remote` (via the
    atomic `db:migrate:local` / `db:migrate:remote` scripts, each `CI=1`) to
    confirm both migrations apply cleanly.
11. Add drift tests (`tests/integration/drift.test.ts`) asserting
    `PRAGMA table_info("<table>")` matches an `EXPECTED_COLUMNS` map for every
    table, and `PRAGMA index_list("<join-table>")` confirms each reverse index
    exists.

### Phase 4 — Data access layer (direct SQL, no ORM)

12. `src/worker/data/tables/*.ts`: one file per entity — a `COLUMNS` tuple
    (never `SELECT *`), a `Row` interface matching the exact column set, and a
    snake_case → camelCase mapper.
13. `src/worker/data/queries/*.ts`: static SQL string constants per entity —
    list-all, by-id, and by-parent-id for every relation in the GraphQL
    Schema table above — declared at module scope. Hoist only the SQL text;
    never a `D1PreparedStatement`, which cannot cross requests.
14. `src/worker/data/repositories/*.ts`: thin functions wrapping
    `env.DB.prepare(...).bind(...).all()`/`.first()` and returning mapped
    domain objects. Each repository function issues exactly one query for
    exactly one parent id — no batching, no `IN (...)` list loading, no
    DataLoader. This is the deliberate naive behavior the demo exists to show;
    say so in the file-level comment of each repository.

### Phase 5 — GraphQL schema and transport

15. `src/worker/graphql/builder.ts`: a minimal Pothos `SchemaBuilder` using
    `@pothos/core` plus `@pothos/plugin-complexity` only — no `plugin-relay`,
    `plugin-scope-auth`, or `plugin-dataloader`; none of those apply without
    auth, pagination, or batching. Pin `graphql@16.14.2` explicitly (not
    `17.0.2`) — Yoga's peer range is `^15.2.0 || ^16.0.0`.
16. `src/worker/graphql/types/*.ts`: one file per entity defining its scalar
    fields and relation fields (each calling the matching repository
    function from Phase 4).
17. `src/worker/graphql/schema.ts`: assembles the `Query` type from every
    type module and exports the built schema. No `Mutation`, no
    `Subscription`.
18. Configure `@pothos/plugin-complexity` with only a `depth` and `breadth`
    limit (for example `limit: { depth: 10, breadth: 50 }`), leaving the
    overall `complexity` limit unset — cost-scoring individual fields is not
    this demo's concern, only bounding how deep and how wide a query into the
    cyclic schema can go. This runs as pre-execution query validation, built
    into the schema builder already in use, so it needs no hand-written
    validation rule or extra envelop plugin. Document in code that this is an
    operational safety net for an endpoint open to any authenticated
    identity with no per-query authorization limits, separate from — and
    must not interfere with — the naive per-parent resolution the demo is
    showing off.
19. `src/worker/index.ts`: a Hono app mounting GraphQL Yoga at `/graphql` with
    GraphiQL enabled unconditionally. No other routes are needed.

### Phase 6 — Observability (making N+1 visible)

20. Wrap the `DB` binding once per request in a thin counting proxy that
    increments a counter on every `prepare()` call, without changing
    statement behavior. Use `cloudflareLogger()` to emit one structured log
    per GraphQL request — `{ operationName, durationMs, statementCount }` —
    after the response resolves, so it always reflects the completed
    request. Never log query variables or SQL text.

### Phase 7 — Tests

21. `src/worker/vitest.config.ts` (`environment: node`, `name: worker`): unit
    tests for every mapper, and one regression test per many-to-many
    repository function asserting it issues exactly one query per call (not
    batched) — framed as "intentionally naive," not a defect.
22. `tests/integration/vitest.config.ts` (`@cloudflare/vitest-pool-workers`,
    `configPath` resolved from `import.meta.dirname`, migrations applied via
    `applyD1Migrations` in a setup file): correctness tests for every flat
    list/by-id query, correctness tests for nested many-to-many and
    one-to-many queries, a statement-count assertion showing a nested query's
    D1 statement count scales with the number of parent rows returned, and
    the drift tests from Phase 3.
23. Configure `@vitest/coverage-istanbul` and a `test:coverage` script. There
    is no `client` Vitest project — list only `worker` and `integration` from
    the root `vitest.config.ts`.

### Phase 8 — Deployment and documentation

24. Provide single-command `npm run deploy` (Terraform init/apply, generate
    `wrangler.jsonc` + types with `generate-wrangler -cf --terraform infra`,
    `db:migrate:remote`, build, `wrangler deploy`) and `npm run teardown`
    (`terraform destroy`), composed from small `package.json` scripts chained
    with `run-s`. A successful teardown leaves no named or billable
    resources — no Worker, D1 database, or Access application.
25. Write `README.md` (operator/developer guide: prerequisites, the D1-backed
    read-only architecture, env config, local dev, testing, observability,
    exact deployment and verification steps, troubleshooting, exact
    teardown), `DEMO.md` (the presenter script from Demo Flow above, plus
    where to read `statementCount` in Workers Logs and how to run the D1
    console query), and `EXPLAIN-DEMO.md` (the GraphQL N+1 problem, why
    many-to-many child connections are the harder variant, what a batched fix
    would look like with `DataLoader` and a `ROW_NUMBER() OVER (PARTITION
    BY …)` query, and links to further reading) — plus JSDoc on every authored
    TypeScript declaration.
26. Verify formatting, linting, type checking, both Vitest projects, the
    production build, the generated Wrangler configuration, and `terraform
    fmt -check` / `terraform validate` in `infra`. Do not run `terraform
    apply`, deploy, or destroy real resources unless the operator explicitly
    requests it and provides the environment.
