# SWAPI GraphQL Explanation

## What this demo teaches

GraphQL lets a client request a nested object graph in one HTTP request, but it does not automatically make the database work constant. This service intentionally resolves each relationship with one D1 query for each parent object so the N+1 query pattern is visible in a real Worker request.

The GraphiQL console is behind a hostname-wide Cloudflare Access allow policy. Access provides the visible sign-in wall, while the Worker remains read-only and has no per-user authorization logic. The Worker emits a structured record after every GraphQL operation with its operation name, duration, and count of D1 statements, making the resolver fan-out inspectable in Workers Logs.

## Request flow

1. Cloudflare Access authenticates the browser before it reaches `/graphql`.
2. GraphQL Yoga parses the request and Pothos executes the read-only schema against the D1 binding.
3. A flat field such as `films` performs one query.
4. Each relationship field performs a separate direct query for its individual parent. For example, every returned film separately queries `film_person` and `person` for `Film.characters`.
5. The request-scoped D1 proxy counts prepared statements, then the Worker logs `operationName`, `durationMs`, and `statementCount` without logging the GraphQL document, variables, or SQL.

## The N+1 pattern

A query for a list of films plus each film's characters starts with one statement for the film list, then adds one character lookup per film. That is the familiar N+1 shape: one list query plus N child queries. Adding `homeworld` to each character adds another query for every returned person, so the total grows with the shape and cardinality of the response rather than remaining close to constant.

The repository queries are deliberately indexed and individually fast. Indexes reduce the cost of each lookup, but cannot remove the number of round trips or D1 statements. This distinction is the point of the demo.

## Why many-to-many is harder

Many-to-many children need both a join-table lookup and a child-table lookup. A production resolver must preserve which children belong to which parent, retain a deterministic child order, and handle parents with no children. A simple `IN (...)` query can load all children, but it does not by itself reassemble the result per parent or apply a per-parent connection limit.

For `Film.characters`, the naive implementation asks the `film_person` join table separately for every film. In a production batch, a loader could accept all requested film IDs for the operation, query the join and person tables once, and group rows by `film_id` before returning each film's list. The same issue appears in both directions of every SWAPI join table.

## Production alternative

For one-to-many and N:1 fields, a request-scoped [DataLoader](https://github.com/graphql/dataloader) batches keys collected during a GraphQL execution into one `WHERE id IN (...)` query and returns results in the key order DataLoader expects. It must be created per request so cached values and authorization context never leak between users or requests.

Many-to-many child connections often need a more explicit SQL shape. Join the relationship and child tables for all parent IDs, then use a window function such as `ROW_NUMBER() OVER (PARTITION BY film_id ORDER BY person.name)` to number children inside each parent group. An outer query can filter that row number to a per-parent limit, and application code groups rows by `film_id`. That preserves connection semantics without reverting to one query per parent. The appropriate approach depends on the desired ordering, pagination rules, and D1 query plan.

This demo does not implement either optimization. Its schema has no pagination and its relation resolvers intentionally stay unbatched so the cost is directly observable.

## Further Reading

- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Worker bindings](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Cloudflare Workers infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/)
- [GraphQL DataLoader](https://github.com/graphql/dataloader)
- [SQLite window functions](https://www.sqlite.org/windowfunctions.html)
