import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/**/*.test.ts"],
      include: ["src/**/*.ts"],
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
    },
    projects: [
      "src/worker/vitest.config.ts",
      "src/client/vitest.config.ts",
      "tests/integration/vitest.config.ts",
    ],
  },
});
