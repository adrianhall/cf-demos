import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * Test-only bindings injected by `../vitest.config.ts`, additive to the real `Env` generated
 * from `wrangler.jsonc` -- `TEST_MIGRATIONS` has no production counterpart at all.
 */
interface TestOnlyEnv {
  readonly TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Apply every `migrations/` file to this test file's own fresh, isolated D1 database before any
 * test runs. Miniflare gives each integration test *file* its own D1 instance with no schema at
 * all -- nothing here auto-applies `migrations/` the way `db:migrate:local`/`db:migrate:remote`
 * do for `vite dev`/a deployed Worker (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 7).
 */
await applyD1Migrations(
  env.DB,
  (env as unknown as TestOnlyEnv).TEST_MIGRATIONS,
);
