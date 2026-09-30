import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

/**
 * Browser-like test project for the React explorer.
 */
export default defineProject({
  resolve: {
    alias: {
      // `tests/client/queries.test.ts` validates the generated documents against the real Pothos
      // schema, so it needs the same single GraphQL copy the Worker project does — see
      // `tests/worker/vitest.config.ts` for why two copies break schema validation outright.
      'graphql': 'graphql/index.js',
      // The components import `next/navigation`, which only Vinext's Vite plugin knows how to
      // resolve — and that plugin is deliberately not in this project, because these tests render
      // components rather than exercise the framework. Pointing the specifier at the very shim
      // Vinext would have chosen keeps the components' imports honest: they are written exactly
      // as they are in the application rather than adjusted to suit the test runner.
      //
      // Resolved through `import.meta.resolve` rather than assembled from a path: Vinext exports
      // `./shims/*` only under the `import` condition, so `createRequire().resolve` is refused,
      // and hard-coding `dist/shims/…` would silently break on an upgrade that moved it.
      'next/navigation': fileURLToPath(import.meta.resolve('vinext/shims/navigation'))
    }
  },
  test: {
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx}'],
    name: 'client',
    setupFiles: ['./setup.ts']
  }
});
