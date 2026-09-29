import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { accessPolicies } from './src/access-policies.ts';

export default defineConfig({
  plugins: [
    cloudflareAccessPlugin({
      policies: accessPolicies,
      // Selectable identity on the local dev login form instead of a free-text email input —
      // matches the `adminEmail` value in `cloudflare.config.ts`'s `LOCAL_DEV_DEFAULTS` object,
      // so picking it and moving on resolves as this demo's administrator. Never seen outside
      // local development: this file only runs under `vite dev`/`vite build`, never bundled
      // into the deployed Worker.
      users: [{ email: 'admin@example.com', name: 'Administrator' }]
    }),
    vue(),
    cloudflare({
      // `cf` v1's Vite-plugin v2 build chain reads cloudflare.config.ts directly and emits the
      // Build Output Spec that `cf deploy --prebuilt` consumes. `cf workers types` generates
      // the matching `.cloudflare/types/index.d.ts` for standalone type checks.
    })
  ]
});
