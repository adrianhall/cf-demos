import { cloudflareAccessPlugin } from "@adrianhall/cloudflare-toolkit/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { Features } from "lightningcss";
import { defineConfig } from "vite";
import { accessPolicies } from "./src/access-policies";

export default defineConfig({
  css: {
    lightningcss: {
      // Vite 8 defaults `build.cssMinify` to Lightning CSS, which -- by default, regardless of
      // browser targets -- downlevels every `light-dark()` value (`app.css`'s entire theming
      // system, e.g. `--cf-surface: light-dark(#fff, #1c1c1e)`) into a pair of
      // `@media (prefers-color-scheme: dark)`-driven custom properties. That media query
      // evaluates against the browser/OS's raw preference and completely ignores the `color-scheme`
      // CSS property this app sets programmatically (`lib/theme.ts`'s `applyTheme()`, via
      // `document.documentElement.style.colorScheme`) to let a user override the OS preference
      // in-app. The practical effect only showed up in a real production build (`vite dev`'s
      // unminified CSS passes `light-dark()` through natively, so this was invisible until
      // `npm run build`/`deploy`): explicit in-app dark-mode toggling silently stopped affecting
      // any `light-dark()`-based background/border color, while unset `color` properties (which
      // rely on the browser's own native, non-polyfilled `color-scheme` handling) kept working --
      // producing exactly the "icons follow the toggle, backgrounds don't" symptom this excludes.
      // `exclude: Features.LightDark` keeps `light-dark()` passed through as native CSS
      // unconditionally, per Lightning CSS's own `exclude` semantics ("features that should
      // never be compiled, even when unsupported by targets") -- correct here because every
      // browser Cloudflare Access/this demo needs to support already ships `light-dark()`
      // natively (Chrome/Edge 123+, Safari 17.5+, Firefox 120+, all older than this repository's
      // other baseline requirements).
      exclude: Features.LightDark,
    },
  },
  plugins: [
    // MUST come before cloudflare() — see the cloudflare-toolkit skill's plugin-ordering note.
    cloudflareAccessPlugin({
      policies: accessPolicies,
      users: [
        { email: "admin@example.com", name: "Administrator" },
        { email: "alice@example.com", name: "Alice Example" },
      ],
    }),
    react(),
    cloudflare(),
  ],
});
