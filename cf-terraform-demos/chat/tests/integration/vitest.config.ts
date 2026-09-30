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
        // chain, so there is no `wrangler.jsonc` to point the test runner at. Declaring the
        // entrypoint and bindings inline keeps the Workers-runtime suite self-describing and
        // avoids reintroducing legacy Wrangler configuration purely for tests.
        main: path.resolve(import.meta.dirname, '../../src/worker/index.ts'),
        miniflare: {
          compatibilityDate: '2026-08-25',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          // The real Durable Object namespace, backed by the real class and the same SQLite
          // storage engine production uses. The WebSocket behaviour these tests cover —
          // hibernatable sockets, attachment-pinned authorship, storage erased on destroy — has
          // no meaningful fake, so it is exercised against the actual runtime.
          durableObjects: {
            CHAT_ROOM: { className: 'ChatRoom', useSQLite: true }
          },
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
      include: ['**/*.test.ts'],
      // Test files share one workerd runtime and its Durable Object storage. Running them
      // concurrently starves hibernatable WebSocket delivery in this pool, so files run one at a
      // time — Cloudflare's own guidance for suites that share a runtime this way.
      fileParallelism: false,
      // Every assertion in this suite ultimately waits for a WebSocket frame, and a frame that
      // never arrives would otherwise wait forever: a socket has no equivalent of a failed HTTP
      // response to reject on. These bounds are the backstop. The per-wait timeout in
      // `./fixtures.ts` is deliberately shorter, so a genuine delivery failure reports *which*
      // frame never came rather than surfacing here as an anonymous timed-out test.
      testTimeout: 10_000,
      // Teardown evicts every Durable Object and forces its sockets closed. Bounded separately
      // because a hook that hangs stalls the whole file rather than failing one test.
      hookTimeout: 15_000
    }
  };
});
