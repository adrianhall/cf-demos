import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/access-policies";

export default defineConfig({
  plugins: [
    // MUST come before cloudflare() — see the cloudflare-toolkit skill's plugin-ordering note.
    cloudflareAccessPlugin({
      policies: accessPolicies,
      users: [
        { email: "presenter@example.com", name: "Presenter" },
        { email: "reviewer@example.com", name: "Reviewer" },
      ],
    }),
    react(),
    cloudflare(),
  ],
});
