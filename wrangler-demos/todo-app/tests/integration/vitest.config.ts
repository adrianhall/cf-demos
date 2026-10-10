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
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: "test",
            TEST_MIGRATIONS: migrations,
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
