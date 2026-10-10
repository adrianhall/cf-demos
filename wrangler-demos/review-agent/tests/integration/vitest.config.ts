import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineProject } from "vitest/config";

export default defineProject(async () => {
  // Read at Vitest-config time (plain Node.js, not inside the pool), then handed to
  // `applyD1Migrations()` (`cloudflare:test`) from `./support/setup.ts` -- Miniflare's own
  // per-test-file D1 database starts empty; nothing auto-applies `migrations/` for it the way
  // `db:migrate:local`/`db:migrate:remote` do for `vite dev`/a deployed Worker.
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "../../migrations"),
  );

  return {
    plugins: [
      // Transforms `ReviewRunAgent`'s `@callable()` TC39 decorator so this project's own Vite
      // pipeline can parse it at all -- without this, any test file that imports (directly or
      // transitively) `src/worker/index.ts`/`ReviewRunAgent.ts` throws a bare
      // "SyntaxError: Invalid or unexpected token" the moment Vite tries to load that module,
      // since `docs/DECISIONS.md` #39's fix only wired this into the root `vite.config.ts` used
      // by `vite dev`/`vite build` -- this project has its own independent Vite pipeline and
      // needs the same plugin registered again. Must run before `cloudflareTest()`, mirroring
      // `vite.config.ts`'s own "transform the source before the Worker-bundling step sees it"
      // ordering.
      agents(),
      cloudflareTest({
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
            // Parsed D1 migrations, applied once per test file by `./support/setup.ts` -- see
            // this block's own comment above.
            TEST_MIGRATIONS: migrations,
            // `GITHUB_TOKEN`/`GITHUB_WEBHOOK_SECRET`/`GITLAB_TOKEN`/`GITLAB_WEBHOOK_SECRET` are
            // one-time `wrangler secret put` values in production (`../../src/worker/bindings.ts`'s
            // `ProviderSecrets` doc comment) and this demo's own gitignored `.dev.vars` locally
            // (docs/07-PR-REVIEW-AGENT.md, "Explicit Exceptions") -- neither exists on a clean
            // checkout, so every test in this project that drives the real Worker end to end
            // (`exports.default.fetch()`, per Implementation Plan Phase 7, item 28) needs fixed,
            // fake values here instead. Matches the literal strings `webhooks.test.ts`/
            // `reviews.test.ts` already hardcode into their own standalone-router fake `env`
            // objects, so a signature/token built against one of these constants in a test
            // verifies correctly regardless of which of the two test styles a given file uses.
            GITHUB_TOKEN: "test-github-token",
            GITHUB_WEBHOOK_SECRET: "test-github-webhook-secret",
            GITLAB_TOKEN: "test-gitlab-token",
            GITLAB_WEBHOOK_SECRET: "test-gitlab-webhook-secret",
          },
        },
        // `AI` has no local simulator at all (docs/05-AI-CHAT.md, "Workers AI Has No Local
        // Simulation"; docs/DECISIONS.md #9), so `@cloudflare/vitest-pool-workers` would
        // otherwise open a credentialed remote proxy session for it on every test run,
        // regardless of the wrangler.jsonc `remote: true` flag. `remoteBindings: false` keeps
        // `npm test` runnable on a clean checkout with no Cloudflare credentials -- `env.AI`
        // still exists in tests, but is non-functional by default; Implementation Plan Phase 7's
        // full-pipeline tests instead override `env.AI` per request with `vi.stubGlobal`-style
        // fakes is not applicable here (`env.AI` is a binding, not a global) -- see
        // `./support/fixtures.ts`'s `withFakeAi()` for how a test substitutes a scripted fake
        // for the one request under test without touching this shared binding.
        remoteBindings: false,
      }),
    ],
    test: {
      name: "integration",
      include: ["**/*.test.ts"],
      setupFiles: ["./support/setup.ts"],
      // Every test in this project shares one real workerd runtime and its Durable Object/
      // Workflow engine state. Phase 7's full-pipeline tests each create a real
      // `ReviewPipelineWorkflow` instance and use `introspectWorkflow()`'s process-wide mocking
      // hooks (`disableSleeps()`, `mockStepError()`, ...) -- running test files concurrently
      // against that shared engine risks one file's mocks leaking into another's instance, the
      // same class of cross-file interference the `testing-durable-objects` skill documents for
      // concurrent WebSocket delivery. Serializing file execution avoids it entirely.
      fileParallelism: false,
    },
  };
});
