import type { D1Reader } from '../infrastructure/d1-reader';
import { createD1Repositories } from '../infrastructure/d1-repositories';
import type { GraphQLContext } from './graphql/context';

/**
 * Wrap a D1 reader so every prepared statement increments a counter.
 *
 * The count is the observability signal this demo is built to expose. A GraphQL endpoint's cost is
 * chosen by the caller, so "how many statements did that query actually run?" is the question that
 * matters — and the answer is what demonstrates that batched loading works: a query returning
 * hundreds of related rows should still report a single-digit count. Request duration alone would
 * not show that, because a fast N+1 query and a batched one can look similar on a small dataset.
 *
 * Counting is done by wrapping rather than by threading a counter through every repository, so the
 * repositories stay free of instrumentation and no future query can forget to be counted.
 *
 * A `Proxy` is used instead of an object literal that re-implements `D1Reader` because the returned
 * value must remain a faithful D1 handle: methods this application does not currently call still
 * behave correctly, and the wrapper does not need updating when the interface it wraps changes.
 * Non-`prepare` members are passed through, with functions bound to the real database so `this` is
 * correct when they are invoked through the proxy.
 *
 * @param database Real D1 handle from the Worker binding.
 * @returns The wrapped handle and a reader for its request-local count. The counter is closed over
 *   rather than stored on the proxy, so it cannot be read or reset by anything holding the
 *   database.
 */
function createCountingReader(database: D1Reader): {
  database: D1Reader;
  countStatements: () => number;
} {
  let count = 0;

  const counting = new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (query: string): D1PreparedStatement => {
          count += 1;
          return target.prepare(query);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    }
  });

  return { database: counting, countStatements: () => count };
}

/**
 * Build the GraphQL context for one request.
 *
 * This is the composition step that connects the tiers: it wraps the infrastructure-tier database
 * handle for counting, builds the six D1 adapters from it, and hands the application tier only the
 * domain-tier _ports_. Resolvers therefore cannot reach the database directly, and swapping D1 for
 * another store would change this function and nothing in `./graphql/`.
 *
 * Called once per request, which is what scopes the DataLoader caches inside the schema's object
 * references to a single caller's query. Building it once per isolate would let one request's
 * loaded entities be served to the next.
 *
 * @param database D1 database bound to the Worker as `DB`.
 * @returns A context carrying request-scoped repositories and this request's statement counter.
 */
export function createRequestContext(database: D1Reader): GraphQLContext {
  const counting = createCountingReader(database);

  return {
    repositories: createD1Repositories(counting.database),
    countStatements: counting.countStatements
  };
}
