import path from 'node:path';
import { defineProject } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

/**
 * Workers-runtime test project.
 *
 * These tests dispatch real requests through the real Worker in a real workerd isolate, which is
 * the only way to prove that Access verification, audience enforcement, and problem-details
 * responses behave as deployed rather than as mocked.
 */
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
        bindings: {
          // Matches the audience and team domain the suite signs development JWTs for. A test
          // that signs a token for a different audience must be rejected, which is what proves
          // the Worker's cross-application replay defence actually works.
          ACCESS_AUD: 'a'.repeat(64),
          CLOUDFLARE_TEAM_DOMAIN: 'local.cloudflareaccess.com',
          // A gateway identifier is bound even though no test performs inference. Its presence
          // mirrors the deployed configuration, so a future phase's inference test does not have
          // to change the harness to become possible.
          AI_GATEWAY_ID: 'playground-test',
          CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
          ENVIRONMENT: 'test'
        }
      }
    })
  ],
  test: {
    name: 'integration',
    // A finite timeout, so a blocked Workers-runtime test fails the run instead of hanging CI or
    // an agentic process indefinitely.
    testTimeout: 10_000,
    include: ['**/*.test.ts']
  }
});
