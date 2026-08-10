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
            ADMIN_EMAIL: "admin@example.com",
            ENVIRONMENT: "test",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      name: "integration",
      include: ["**/*.test.ts"],
      // `diagram-session.test.ts` opens real hibernatable WebSocket connections against this
      // shared workerd runtime. Running test files concurrently can intermittently starve
      // hibernatable WebSocket delivery in this pool -- see the testing-durable-objects skill
      // (`docs/DECISIONS.md` item 8) and `demos/chat`'s own precedent -- so file execution is
      // serialized for this project.
      fileParallelism: false,
    },
  };
});
