import { Features } from 'lightningcss';
import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { buildAccessPolicies } from './src/access-policies.ts';

export default defineConfig({
  css: {
    lightningcss: {
      // Vite defaults `build.cssMinify` to Lightning CSS, which — by default, regardless of
      // browser targets — downlevels every `light-dark()` value (`src/client/app.css`'s entire
      // theming system, e.g. `--cf-surface: light-dark(#ffffff, #1c1c1e)`) into a pair of
      // `@media (prefers-color-scheme: dark)`-driven custom properties. That media query
      // evaluates against the browser/OS's raw preference and completely ignores the
      // `color-scheme` CSS property this app sets programmatically (`src/client/lib/theme.ts`'s
      // `applyTheme()`, via `document.documentElement.style.colorScheme`) to let a user override
      // the OS preference in-app.
      //
      // The practical effect only shows up in a real production build — `vite dev`'s unminified
      // CSS passes `light-dark()` through natively, so the regression is invisible until a build:
      // explicit in-app dark-mode toggling silently stops affecting any `light-dark()`-based
      // background or border colour, while unset `color` properties (which rely on the browser's
      // own native `color-scheme` handling) keep working — producing exactly the "icons follow
      // the toggle, backgrounds don't" symptom. `tests/build/built-css.test.ts` asserts against
      // the **built** stylesheet for that reason; the source file looks correct either way.
      //
      // `exclude: Features.LightDark` keeps `light-dark()` as native CSS unconditionally, per
      // Lightning CSS's own `exclude` semantics ("features that should never be compiled, even
      // when unsupported by targets") — correct here because every browser this demo supports
      // already ships it natively (Chrome/Edge 123+, Safari 17.5+, Firefox 120+).
      exclude: Features.LightDark
    }
  },
  plugins: [
    // MUST come before cloudflare() — see the cloudflare-toolkit skill's plugin-ordering note.
    cloudflareAccessPlugin({
      // The same policy list the Worker enforces, including its audience, built from the same
      // committed local placeholder that `cloudflare.config.ts` binds as `ACCESS_AUD`. Sharing one
      // definition means a local sign-in exercises the identical audience check the deployed
      // Worker performs, rather than a weaker development-only variant.
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      // Two fixed identities, because the behaviour this demo teaches is the difference between
      // them: the first matches the committed `admin_email` placeholder and therefore sees the
      // administrative surface; the second is an ordinary owner and must not. A free-text email
      // field would work too, but two fixed identities make the comparison reproducible during a
      // presentation. Never seen outside local development — this file only runs under
      // `vite dev`/`vite build` and is never bundled into the deployed Worker.
      users: [
        { email: localOutputs.admin_email.value, name: 'Administrator' },
        { email: 'alice@example.com', name: 'Alice Example' }
      ]
    }),
    react(),
    cloudflare({
      // `cf` v1's Vite-plugin v2 build chain reads cloudflare.config.ts directly and emits the
      // Build Output Spec that `cf deploy --prebuilt` consumes. `cf workers types` generates
      // the matching `.cloudflare/types/index.d.ts` for standalone type checks.
    })
  ]
});
