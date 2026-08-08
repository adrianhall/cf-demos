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
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.config.{ts,js}",
        "**/*.d.ts",
        // Test doubles/setup, not authored application source: `mock-xyflow.tsx` stubs every
        // `@xyflow/react` export other test files import from, so plenty of its own branches
        // are exercised only by whichever subset a given test file actually needs.
        "src/client/test/**",
      ],
    },
  },
});
