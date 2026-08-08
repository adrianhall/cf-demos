import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `../*.test.ts` (relative to this project's root, `src/worker/`) picks up unit tests
    // colocated next to top-level shared modules like `../catalog.ts`/`../blueprints.ts`/
    // `../access-policies.ts` (AGENTS.md's colocation rule) -- pure data/logic with no Worker
    // bindings, so the `node` environment here fits them exactly as well as it fits everything
    // under `src/worker/` itself.
    include: ["**/*.test.ts", "../*.test.ts"],
    name: "worker",
  },
});
