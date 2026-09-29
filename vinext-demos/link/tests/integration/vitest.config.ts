import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineProject({
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
        kvNamespaces: ['LINKS'],
        bindings: {
          // Matches the identity `adminRequest` (worker.test.ts) signs development JWTs for, and
          // the Access team domain those tokens are issued against.
          ADMIN_EMAIL: 'admin@example.com',
          CLOUDFLARE_TEAM_DOMAIN: 'local.cloudflareaccess.com',
          ENVIRONMENT: 'test'
        }
      }
    })
  ],
  test: {
    name: 'integration',
    include: ['**/*.test.ts']
  }
});
