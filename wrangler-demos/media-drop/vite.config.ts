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
        { email: "creator@example.com", name: "Creator" },
        { email: "another-creator@example.com", name: "Another creator" },
      ],
    }),
    vue(),
    cloudflare(),
  ],
});
