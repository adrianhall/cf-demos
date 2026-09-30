import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `graphql` ships both a CommonJS entry (`main: index`) and an ES module one
  // (`module: index.mjs`), and without this alias one test run loads both. Vite resolves the ESM
  // entry for code it transforms (these test files and `src/`), while `@pothos/core` is externalized
  // and `require`s the CommonJS entry in Node. The schema is then built from one copy's classes and
  // asserted against the other's, so `instanceof GraphQLObjectType` is false for a type that
  // genuinely is one, and `validate()` refuses the schema outright.
  //
  // Pinning both sides to the CommonJS entry — the one the externalized dependency loads — leaves a
  // single copy of the library, and with it a single set of classes and a single type registry.
  //
  // This affects only these Node-environment unit tests. The deployed Worker and the
  // Workers-runtime suite in `tests/integration/` are bundled, so everything there already shares
  // one copy.
  resolve: {
    alias: {
      graphql: 'graphql/index.js'
    }
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    name: 'worker'
  }
});
