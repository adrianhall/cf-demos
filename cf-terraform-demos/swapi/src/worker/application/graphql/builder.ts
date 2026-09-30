import SchemaBuilder from '@pothos/core';
import ComplexityPlugin from '@pothos/plugin-complexity';
import DataloaderPlugin from '@pothos/plugin-dataloader';
import type { GraphQLContext } from './context';

/**
 * Upper bound on how many fields one operation may select in total.
 *
 * Breadth and depth together are what make this endpoint's cost bounded despite the caller choosing
 * the query shape. Cloudflare Access already restricts _who_ may call it (see
 * `src/access-policies.ts`), but an authenticated caller can still compose an expensive query by
 * accident, and this schema is cyclic: `film → characters → films → characters` is valid GraphQL
 * and has no natural end. Without a limit, one request could fan out until the Worker hit its
 * CPU-time limit.
 *
 * 50 comfortably accommodates every query this demo exists to show — including the deep nested
 * traversals in the README — while refusing the pathological ones.
 */
const MAX_QUERY_BREADTH = 50;

/**
 * Maximum nesting depth of one operation.
 *
 * 10 allows the four- and five-level traversals that demonstrate batched loading, and stops the
 * unbounded cycles the relations make expressible.
 */
const MAX_QUERY_DEPTH = 10;

/**
 * Shared Pothos schema builder for the Star Wars schema.
 *
 * Two plugins, each doing something this schema genuinely needs:
 *
 * - **Dataloader** provides the `loadableObjectRef` and `loadableGroup` field builders used in
 *   `./types/`. They are what turn a per-row resolver into one batched repository call per relation
 *   per request, which is the whole reason the domain ports only accept sets of identifiers.
 * - **Complexity** enforces {@link MAX_QUERY_BREADTH} and {@link MAX_QUERY_DEPTH} during validation,
 *   so an over-large query is rejected before a single row is read rather than after.
 *
 * The limits are a structural guard on query _shape_, evaluated statically. They are deliberately
 * not a substitute for the per-relation `first` bound in `../../domain/relation-limit.ts`, which
 * constrains the number of _rows_ a single field may return — a query can be well within both
 * limits here and still ask for every character in the dataset.
 *
 * `Context` is typed as {@link GraphQLContext}, so every resolver's third argument is the
 * repository set rather than raw Worker bindings, and a resolver that tried to reach for `env.DB`
 * would not type-check.
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
}>({
  plugins: [DataloaderPlugin, ComplexityPlugin],
  complexity: {
    limit: {
      breadth: MAX_QUERY_BREADTH,
      depth: MAX_QUERY_DEPTH
    }
  }
});
