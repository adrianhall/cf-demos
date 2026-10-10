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
        // `AI` has no local simulator at all (docs/05-AI-CHAT.md, "Workers AI Has No Local
        // Simulation"), so `@cloudflare/vitest-pool-workers` would otherwise open a credentialed
        // remote proxy session for it on every test run, regardless of `wrangler.jsonc`'s own
        // `remote: true` flag. `remoteBindings: false` keeps `npm run test:integration` runnable
        // on a clean checkout with no Cloudflare credentials -- matching `demos/ai-chat`'s own
        // identical precedent for the same binding. `env.AI` still exists in tests but is
        // non-functional; this repository's own investigation into stubbing it for a real
        // end-to-end chat test is documented on `handleChatMessage`'s integration test(s) below.
        remoteBindings: false,
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
