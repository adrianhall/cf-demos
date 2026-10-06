import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

/**
 * Absolute path to the one `graphql` module file every side of a test run must load.
 *
 * Resolved through `createRequire` rather than hard-coded, because v17 selects its entry through
 * package `exports` conditions and the winning file is not predictable from the package root.
 */
const graphqlEntry = createRequire(import.meta.url).resolve('graphql');

export default defineConfig({
  // `graphql` publishes several builds of itself behind `exports` conditions, and without this
  // alias one test run loads two of them. Vite resolves with the `development` condition, which
  // selects the `__dev__/` build, while `@pothos/core` is externalized and resolves in Node, which
  // selects the plain build. The schema is then built from one copy's classes and asserted against
  // the other's, so `instanceof GraphQLObjectType` is false for a type that genuinely is one, and
  // `validate()` refuses the schema outright — v17's guard reports this as "from another module or
  // realm", because the `__dev__` build is precisely the one that enables that check.
  //
  // Pinning both sides to the single file Node resolves — the one the externalized dependency
  // loads — leaves one copy of the library, and with it one set of classes and one type registry.
  //
  // This affects only these Node-environment unit tests. The deployed Worker and the
  // Workers-runtime suite in `tests/integration/` are bundled, so everything there already shares
  // one copy.
  resolve: {
    alias: {
      graphql: graphqlEntry
    }
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    name: 'worker'
  }
});
