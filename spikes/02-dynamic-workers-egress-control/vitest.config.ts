/**
 * @file Vitest config for Spike C (docs/06-AGENTIC-CHAT.md Section 8, Phase 0 Spike C). Per
 * Section 8's "do not write tests for a spike unless the test is what runs the spike": these two
 * test files exist only because the spike's own stated aim explicitly asks two testability
 * questions ("does `@cloudflare/vitest-pool-workers` support `worker_loaders` locally for
 * integration tests" and "is the gateway unit-testable by injecting a fake fetch") — the tests
 * *are* how those two questions get answered, not a mock-based confirmation of something already
 * live-verified another way.
 */
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.resolve(import.meta.dirname, "wrangler.jsonc"),
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
