import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "jsdom",
    include: ["**/*.test.tsx", "**/*.test.ts"],
    name: "client",
    setupFiles: ["./test/setup.ts"],
  },
});
