/** @file Local workerd configuration for the collaboration-room probe. */
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(import.meta.dirname, "wrangler.jsonc") },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    // Hibernatable sockets share the workerd pool, so test files must not run concurrently.
    fileParallelism: false,
  },
});
