import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "node",
    include: ["**/*.test.ts", "../../../scripts/**/*.test.ts"],
    name: "worker",
  },
});
