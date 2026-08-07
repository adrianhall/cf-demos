import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
      },
      // Workers AI has no local simulator. Phase 1 invokes no model, so replace the configured
      // binding with an inert test equivalent and keep the integration pool fully local.
      miniflare: { bindings: { AI: {}, ENVIRONMENT: "test" } },
    }),
  ],
  test: { include: ["**/*.test.ts"], name: "integration" },
});
