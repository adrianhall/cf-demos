import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/** Build the disposable local Vue editor. */
export default defineConfig({
  plugins: [vue()],
});
