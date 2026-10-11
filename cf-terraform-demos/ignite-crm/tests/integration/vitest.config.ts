import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

/**
 * Workers-runtime integration project: both Workers in one workerd process.
 *
 * `system-entry.ts` exports the Application Worker as the default export and the Data Worker's
 * `DataEntrypoint` as a named export. `DATA_SERVICE` is a service binding back to this same
 * Worker's `DataEntrypoint`, so every Application → Data call crosses a genuine Workers RPC
 * boundary — with real structured-clone serialization — exactly as it does between the two deployed
 * Workers.
 *
 * Migrations are read here, in Node, and applied inside the isolated D1 database by the suites'
 * `beforeAll` hooks, so the committed migration SQL is what these tests exercise.
 */
export default defineProject(async () => {
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, '../../migrations/data')
  );

  return {
    plugins: [
      cloudflareTest({
        main: path.resolve(import.meta.dirname, './system-entry.ts'),
        miniflare: {
          compatibilityDate: '2026-10-07',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DATA_DB'],
          serviceBindings: {
            DATA_SERVICE: {
              name: Symbol.for('miniflare.kCurrentWorker'),
              entrypoint: 'DataEntrypoint'
            } as never
          },
          bindings: {
            ACCESS_AUD: 'a'.repeat(64),
            ADMIN_EMAIL: 'owner@example.com',
            ENVIRONMENT: 'test',
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      name: 'integration',
      include: ['**/*.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000
    }
  };
});
