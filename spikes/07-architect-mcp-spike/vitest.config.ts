/**
 * @file Vitest config for the Phase 11 spike (docs/09B-ARCHITECT-MCP.md, "Phase 11 - Spike").
 * Per the Spike Conventions ("do not write tests for a spike unless the test is what runs the
 * spike"): this test file exists only because the spike's stated aim explicitly asks a
 * testability question — "does elkjs's layout algorithm run unmodified inside workerd?" — the
 * test *is* how that question gets answered, not a mock-based confirmation of an assumption.
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
  },
});
