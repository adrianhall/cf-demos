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
      // Phase 2 adds real WebSocket connections to `ChatAgent` Durable Objects. Test files that
      // open real WebSockets against this pool's shared workerd runtime can intermittently hang
      // when run concurrently -- see the `testing-durable-objects` skill and
      // `docs/DECISIONS.md` item 8.
      fileParallelism: false,
    },
  };
});
