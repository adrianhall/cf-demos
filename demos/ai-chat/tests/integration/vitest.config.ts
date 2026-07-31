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
        // `AI` has no local simulator at all (see docs/05-AI-CHAT.md, "Workers AI Has No Local
        // Simulation"), so `@cloudflare/vitest-pool-workers` would otherwise open a credentialed
        // remote proxy session for it on every test run, regardless of the wrangler.jsonc
        // `remote: true` flag. `remoteBindings: false` keeps `npm test` runnable on a clean
        // checkout with no Cloudflare credentials — `env.AI` still exists in tests, but is
        // non-functional, which is correct: tests inject their own fake `Ai` implementation
        // instead of calling the real binding.
        remoteBindings: false,
      }),
    ],
    test: {
      name: "integration",
      include: ["**/*.test.ts"],
    },
  };
});
