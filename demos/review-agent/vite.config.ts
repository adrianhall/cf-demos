import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vue from "@vitejs/plugin-vue";
import agents from "agents/vite";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/worker/access-policies";

export default defineConfig({
  plugins: [
    // Emulates the Access edge locally, reading the same `accessPolicies` array
    // `cloudflareAccess()` validates against in production (docs/07-PR-REVIEW-AGENT.md, "Access
    // Model") -- so the two webhook paths need no dev sign-in at all here either, and every
    // other path prompts this plugin's local login form. Must run before `cloudflare()`.
    cloudflareAccessPlugin({
      policies: accessPolicies,
      // Selectable identity on the local dev login form. There is no per-user allowlist on this
      // hostname -- any authenticated identity has equal access (docs/07-PR-REVIEW-AGENT.md,
      // "Access Model") -- so this is a generic reviewer identity, not an "admin" one.
      users: [{ email: "reviewer@example.com", name: "Reviewer" }],
    }),
    // Transforms `ReviewRunAgent`'s `@callable()` TC39 decorator so it works at runtime -- the
    // Cloudflare Vite plugin's own worker-entry-export-type detection (and Rolldown/esbuild's
    // bundling) cannot parse a bare, untransformed standard-decorators class member on their
    // own (`docs/DECISIONS.md` #38 covers the analogous `@vitest/coverage-istanbul` gap this
    // same decorator syntax hit). Must run before `cloudflare()`, for the same "transform the
    // source before the Worker bundling step sees it" reason as `vue()`.
    agents(),
    vue(),
    cloudflare(),
  ],
});
