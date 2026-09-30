import type { SwapiRepositories } from '../../domain/repositories';

/**
 * Per-request GraphQL context.
 *
 * Resolvers receive this as their third argument and use nothing else to reach data. In particular
 * it carries the repository _ports_, not the D1 binding: no resolver can reach `env.DB`, so no
 * resolver can issue an unbatched query or construct SQL of its own. That is the dependency rule
 * the four-tier architecture asks for, made concrete — the application tier depends on interfaces
 * from the domain tier, and the concrete D1 adapters are injected at the edge by
 * `src/worker/index.ts`.
 *
 * A fresh context is built for every request, which is what makes the DataLoader caches inside the
 * object references request-scoped. A context shared across requests would leak one caller's loaded
 * entities into another's query.
 */
export interface GraphQLContext {
  /**
   * The six persistence ports every resolver reads through.
   */
  repositories: SwapiRepositories;
  /**
   * Counts the D1 statements executed while resolving the current request.
   *
   * Exposed on the context so the route can report it in one structured log line per request. That
   * number is the headline observability signal for this demo: it is what demonstrates that a
   * deeply nested query costs a handful of statements rather than one per row, and a regression in
   * the batching would show up here as a count that scales with the data.
   */
  countStatements(): number;
}
