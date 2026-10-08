import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

/**
 * Workers-runtime test project.
 *
 * The migrations are read here, in Node, and injected as a binding rather than applied by the `cf`
 * CLI: the Workers pool creates its own isolated, in-memory D1 database per test run, which the CLI
 * cannot address. The suite then calls `applyD1Migrations` in a `beforeAll` hook to build the
 * schema inside that database — so these tests exercise the real migration SQL against a real D1
 * implementation, and a broken migration fails the suite rather than only failing a deploy.
 */
export default defineProject(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, '../../migrations'));

  return {
    plugins: [
      cloudflareTest({
        // The deployed Worker is configured by `cloudflare.config.ts` through the `cf` build
        // chain, so there is no Wrangler configuration to point the test runner at. Declaring the
        // entrypoint and bindings inline keeps the Workers-runtime suite self-describing.
        main: path.resolve(import.meta.dirname, '../../src/worker/index.ts'),
        miniflare: {
          compatibilityDate: '2026-08-25',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          kvNamespaces: ['SHARES'],
          bindings: {
            // Matches the audience the suite signs development JWTs for. A test that signs a
            // token for a different audience must be rejected, which is what proves the Worker's
            // cross-application replay defence actually works.
            ACCESS_AUD: 'a'.repeat(64),
            ADMIN_EMAIL: 'admin@example.com',
            CLOUDFLARE_TEAM_DOMAIN: 'local.cloudflareaccess.com',
            // The MCP handler validates Host itself. A fictional binding keeps the runtime suite
            // hermetic while proving the value is supplied through the Worker configuration rather
            // than hard-coded in the handler.
            PUBLIC_HOSTNAME: 'diagrams.test',
            ENVIRONMENT: 'test',
            // Parsed migrations applied by the suite's `beforeAll` hook.
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      name: 'integration',
      // A finite budget so a blocked runtime test fails rather than hanging CI indefinitely.
      testTimeout: 10_000,
      include: ['**/*.test.ts']
    }
  };
});
