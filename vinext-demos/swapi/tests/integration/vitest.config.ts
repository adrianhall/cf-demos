import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

/**
 * Workers-runtime test project.
 *
 * The migrations are read here, in Node, and injected as a binding rather than applied by the `cf`
 * CLI: the Workers pool creates its own isolated, in-memory D1 database per test run, which the CLI
 * cannot address. The suite then calls `applyD1Migrations` in a `beforeAll` hook to build the
 * schema and load the seed data inside that database — so these tests exercise the real migration
 * SQL, including all three literal seed files, against a real D1 implementation. A broken migration
 * fails the suite rather than only failing a deploy, and the GraphQL assertions run against the
 * same data the deployed API serves.
 */
export default defineProject(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, '../../migrations'));

  return {
    plugins: [
      cloudflareTest({
        // The deployed Worker is configured by `cloudflare.config.ts` through the `cf` build chain,
        // so there is no `wrangler.jsonc` to point the test runner at. Declaring the entrypoint and
        // bindings inline keeps the Workers-runtime suite self-describing and avoids reintroducing
        // legacy Wrangler configuration purely for tests.
        main: path.resolve(import.meta.dirname, '../../src/worker/index.ts'),
        miniflare: {
          compatibilityDate: '2026-08-25',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: {
            // Matches the audience and team domain the suite signs development JWTs for. A test
            // that signs a token for a different audience must be rejected, which is what proves
            // the Worker's cross-application replay defence actually works.
            ACCESS_AUD: 'a'.repeat(64),
            CLOUDFLARE_TEAM_DOMAIN: 'local.cloudflareaccess.com',
            ENVIRONMENT: 'test',
            // Parsed migrations applied by the suite's `beforeAll` hook.
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      name: 'integration',
      testTimeout: 10_000,
      include: ['**/*.test.ts'],
      setupFiles: ['./setup.ts']
    }
  };
});
