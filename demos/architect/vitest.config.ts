import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./src/client/vitest.config.ts",
      "./src/worker/vitest.config.ts",
      "./tests/integration/vitest.config.ts",
    ],
    coverage: {
      exclude: ["**/*.config.ts", "**/*.d.ts", "**/*.test.ts"],
      include: ["src/**/*.{ts,vue}"],
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
