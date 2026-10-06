import { createRequire } from 'node:module';
import { defineProject } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * Absolute path to the one `graphql` module file every side of a test run must load.
 *
 * Resolved through `createRequire` rather than hard-coded, because v17 selects its entry through
 * package `exports` conditions and the winning file is not predictable from the package root.
 */
const graphqlEntry = createRequire(import.meta.url).resolve('graphql');

export default defineProject({
  resolve: {
    // See tests/worker/vitest.config.ts for the full explanation. Client tests that validate the
    // Pothos schema must load the same GraphQL build as externalized Pothos, or GraphQL's
    // instanceof-based schema guard sees two realms and refuses a perfectly real schema.
    alias: { graphql: graphqlEntry }
  },
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['**/*.test.ts'],
    name: 'client',
    setupFiles: ['./setup.ts'],
    server: { deps: { inline: [/vuetify/] } }
  }
});
