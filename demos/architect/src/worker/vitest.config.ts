import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "node",
    // `../graph/**` also matches this Node-environment project — the graph module is shared
    // with the client (`src/graph/*.ts`, per `docs/09-ARCHITECT.md` Phase 2) but has no DOM
    // dependency, so its pure unit tests belong here rather than in a third Vitest project that
    // `package.json`'s `test:unit`/`test:worker` scripts would then also need to select.
    include: ["**/*.test.ts", "../graph/**/*.test.ts"],
    name: "worker",
  },
});
