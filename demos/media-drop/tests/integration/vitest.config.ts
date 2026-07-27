import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
      },
    }),
  ],
  test: {
    include: ["**/*.test.ts"],
    name: "integration",
  },
});
