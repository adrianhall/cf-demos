import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineProject(async () => {
  const migrations = await readD1Migrations(path.resolve(import.meta.dirname, '../../migrations'));
  return {
    plugins: [
      cloudflareTest({
        main: path.resolve(import.meta.dirname, '../../src/worker/index.ts'),
        miniflare: {
          compatibilityDate: '2026-10-03',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: {
            ACCESS_AUD: 'a'.repeat(64),
            CLOUDFLARE_TEAM_DOMAIN: 'local.cloudflareaccess.com',
            AI_GATEWAY_ID: 'sales-bot-test',
            TEST_MIGRATIONS: migrations
          }
        }
      })
    ],
    test: {
      name: 'integration',
      include: ['**/*.test.ts'],
      testTimeout: 10_000,
      hookTimeout: 10_000
    }
  };
});
