import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Cloudflare Access wiring (`cloudflareAccessPlugin` + a shared `src/access-policies.ts`) lands
// in Phase 2, once the Worker's own `cloudflareAccess()` middleware exists to share policies
// with. See docs/02-TODO-APP.md.
export default defineConfig({
  plugins: [vue(), cloudflare()],
});
