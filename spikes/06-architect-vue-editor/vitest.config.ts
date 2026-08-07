import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/** Configure browser-like component tests and pure graph tests. */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
