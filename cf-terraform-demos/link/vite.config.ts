import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { buildAccessPolicies } from './src/access-policies.ts';

export default defineConfig({
  plugins: [
    cloudflareAccessPlugin({
      // The same policy list the Worker enforces, including its audience, built from the same
      // committed local placeholder that `cloudflare.config.ts` binds as `ACCESS_AUD`. Sharing one
      // definition means a local sign-in exercises the identical audience check the deployed
      // Worker performs, rather than a weaker development-only variant.
      policies: buildAccessPolicies(localOutputs.access_aud.value),
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
