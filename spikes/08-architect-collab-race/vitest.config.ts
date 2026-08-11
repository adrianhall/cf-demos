/**
 * @file Vitest config for the Phase 16 spike (docs/09C-COLLABORATIVE-EDITING.md, "Phase 16 -
 * Spike"). Per the Spike Conventions ("do not write tests for a spike unless the test is what
 * runs the spike"): this spike's stated aim is a testability question about the Durable Object
 * execution model itself -- these tests *are* how that question gets answered, not a mock-based
 * confirmation of an assumption.
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
    include: ["tests/**/*.test.ts"],
    // Both test files call RPC methods concurrently against the same TestDiagramSession instance
    // and rely on real setTimeout-based delays to model slow/fast persists. Running test files
    // concurrently against a shared workerd pool is exactly the condition the
    // testing-durable-objects skill warns can intermittently starve timing-sensitive delivery, so
    // file execution is serialized here too, matching demos/architect's own precedent.
    fileParallelism: false,
  },
});
