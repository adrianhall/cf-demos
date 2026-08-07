import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject(async () => {
  // Miniflare's D1 simulator starts empty; Phase 2's `diagrams` table (and its siblings) only
  // exist after migrations are applied. `TEST_MIGRATIONS` is a test-only binding read by
  // `applyD1Migrations()` in a test file's own `beforeAll` (see `diagrams.test.ts`) — this
  // mirrors `demos/todo-app`'s own integration setup for the same reason.
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "../../migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
        },
        // Workers AI has no local simulator. Phase 1 invokes no model, so replace the configured
        // binding with an inert test equivalent and keep the integration pool fully local.
        miniflare: {
          bindings: {
            AI: {},
            ENVIRONMENT: "test",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["**/*.test.ts"],
      name: "integration",
      // Every test file in this project shares one real workerd runtime and its Durable Object
      // storage. Phase 2's diagram tests call DiagramRoom RPC methods directly (and
      // evictAllDurableObjects() in afterEach); the testing-durable-objects skill's
      // serialization rule for any Durable-Object-touching integration suite applies
      // regardless of whether a given file opens a real WebSocket, so this is set
      // repository-wide for this project.
      fileParallelism: false,
    },
  };
});
