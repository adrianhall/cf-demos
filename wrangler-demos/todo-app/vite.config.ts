import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/access-policies";

export default defineConfig({
  plugins: [
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
