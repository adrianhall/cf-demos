import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./src/client/vitest.config.ts",
      "./src/worker/vitest.config.ts",
      "./tests/integration/vitest.config.ts",
    ],
    coverage: {
      provider: "istanbul",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx,vue}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.config.{ts,js}", "**/*.d.ts"],
    },
  },
});
