import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "html"],
    },
    projects: [
      "src/worker/vitest.config.ts",
      "src/client/vitest.config.ts",
      "tests/integration/vitest.config.ts",
    ],
  },
});
