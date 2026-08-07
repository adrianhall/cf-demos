import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Configures a local workerd pool using the same binding declaration as Wrangler. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.resolve(import.meta.dirname, "wrangler.jsonc") },
    }),
  ],
  test: { fileParallelism: false, include: ["tests/**/*.test.ts"] },
});
