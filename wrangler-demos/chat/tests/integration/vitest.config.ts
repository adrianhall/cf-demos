import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject(() => {
  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
          },
        },
      }),
    ],
    test: {
      name: "integration",
      include: ["**/*.test.ts"],
      // Integration test files share one real workerd runtime and its Durable Object storage.
      // Running files concurrently intermittently starves hibernatable WebSocket delivery in
      // this pool (see docs/DECISIONS.md); Cloudflare's own migration guide recommends
      // serializing file execution for suites that share a runtime instance this way.
      fileParallelism: false,
    },
  };
});
