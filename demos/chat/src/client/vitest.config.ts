import vue from "@vitejs/plugin-vue";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    include: ["**/*.test.ts"],
    name: "client",
    setupFiles: ["./test/setup.ts"],
    server: {
      deps: {
        inline: [/vuetify/],
      },
    },
  },
});
