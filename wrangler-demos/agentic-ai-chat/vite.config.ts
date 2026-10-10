import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/access-policies";

export default defineConfig({
  plugins: [
    cloudflareAccessPlugin({
      policies: accessPolicies,
      // Matches the "admin_email" value in `infra/local-outputs.json` (used by
      // `generate-wrangler -l` for ADMIN_EMAIL), so picking it and moving on resolves as this
      // demo's bootstrapped administrator. `alice@example.com` is a second, ordinary identity
      // for exercising per-user isolation locally. Never seen outside local development: this
      // file only runs under `vite dev`/`vite build`, never bundled into the deployed Worker.
      users: [
        { email: "admin@example.com", name: "Administrator" },
        { email: "alice@example.com", name: "Alice Example" },
      ],
    }),
    vue(),
    cloudflare(),
  ],
});
