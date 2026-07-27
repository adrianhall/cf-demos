import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject(async () => {
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "../../migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
            TEST_MIGRATIONS: migrations,
          },
        },
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
      }),
    ],
    test: {
      include: ["**/*.test.ts"],
      name: "integration",
    },
  };
});
