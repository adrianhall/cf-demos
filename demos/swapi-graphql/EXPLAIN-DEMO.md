# SWAPI GraphQL Explanation

## What this demo teaches

GraphQL lets a client request a nested object graph in one HTTP request, but it does not automatically make database work constant. This service uses request-scoped Pothos DataLoaders so relation resolvers batch their parent IDs into indexed D1 queries instead of creating an N+1 query pattern.

The GraphiQL console is behind a hostname-wide Cloudflare Access allow policy. Access provides the visible sign-in wall, while the Worker remains read-only and has no per-user authorization logic. The Worker emits a structured record after every GraphQL operation with its operation name, duration, and count of D1 statements, making the resolver fan-out inspectable in Workers Logs.

## Request flow

1. Cloudflare Access authenticates the browser before it reaches `/graphql`.
2. GraphQL Yoga parses the request and Pothos executes the read-only schema against the D1 binding.
3. A flat field such as `films` performs one query.
4. Each relationship field collects the parent IDs reached at the same GraphQL selection path. Pothos then runs one indexed D1 query for the batch and groups rows back by parent ID.
5. The request-scoped D1 proxy counts prepared statements, then the Worker logs `operationName`, `durationMs`, and `statementCount` without logging the GraphQL document, variables, or SQL.

## Avoiding N+1

Without batching, a query for films plus each film's characters starts with one statement for the film list then adds one character lookup per film. Adding `homeworld` adds another lookup per person. With this implementation, the same query prepares one film statement, one `film_person`/`person` batch statement, and one planet batch statement: three statements rather than 169 for the committed seed data.

Each batch uses existing foreign-key or reverse join-table indexes. This reduces D1 round trips and lets the database read only rows relevant to the selected parents.

## Why many-to-many is harder

Many-to-many children need both a join-table lookup and a child-table lookup. A production resolver must preserve which children belong to which parent, retain a deterministic child order, and handle parents with no children. A simple `IN (...)` query can load all children, but it does not by itself reassemble the result per parent or apply a per-parent connection limit.

For `Film.characters`, the loader accepts every film ID selected at that path, joins `film_person` and `person` once, and groups rows by `film_id`. The same pattern applies in both directions of every SWAPI join table.

## Production alternative

For N:1 fields, a request-scoped [DataLoader](https://github.com/graphql/dataloader) batches keys collected during GraphQL execution into one `WHERE id IN (...)` query. Pothos owns these loaders on the GraphQL context; no loader or D1 prepared statement is stored at module scope, preventing cross-request cache leakage and invalid cross-request I/O.

Many-to-many child fields accept an optional `first` value from 1 through 100. When supplied, the batch query uses `ROW_NUMBER() OVER (PARTITION BY film_id ORDER BY person.name, person.id)` and filters the outer query by that row number, preserving deterministic, per-parent limits without reverting to a query per parent.

The D1 maximum is 100 bound parameters per query, so every Pothos loader uses `maxBatchSize: 90`; this leaves a parameter slot for `first` and prevents load-dependent query failures. Omitting `first` preserves the complete result for this small reference dataset. A production API with larger or user-controlled result graphs should move these fields to cursor-paginated Relay connections.

## Further Reading

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Worker bindings](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Cloudflare Workers infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)
- [GraphQL DataLoader](https://github.com/graphql/dataloader)
- [SQLite window functions](https://www.sqlite.org/windowfunctions.html)
