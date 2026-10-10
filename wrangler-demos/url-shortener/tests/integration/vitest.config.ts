import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject(async () => {
  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
        miniflare: {
          bindings: {
            // Overridden independently of whatever `ADMIN_EMAIL` happens to be in the
            // currently generated `wrangler.jsonc` (real Terraform output or local
            // placeholder), matching the "admin@example.com" identity `adminRequest`
            // (worker.test.ts) signs dev JWTs for.
            ADMIN_EMAIL: "admin@example.com",
            ENVIRONMENT: "test",
          },
        },
      }),
    ],
    test: {
      name: "integration",
      include: ["**/*.test.ts"],
    },
  };
});
