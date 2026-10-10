import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/access-policies";

export default defineConfig({
  plugins: [
    // Order matters: this must run before cloudflare() so its connect middleware can inject the
    // emulated Access identity headers — including on the WebSocket upgrade path added in
    // Phase 3 — before the request is dispatched into the Worker runtime.
    cloudflareAccessPlugin({
      policies: accessPolicies,
      users: [
        { email: "alice@example.com", name: "Alice Example" },
        { email: "bob@example.com", name: "Bob Example" },
      ],
    }),
    vue(),
    cloudflare(),
  ],
});
