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
      // definition means a local sign-in exercises the identical audience check the deployed Worker
      // performs, rather than a weaker development-only variant.
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      // Two selectable identities, because the behaviour this demo teaches is per-user isolation:
      // sign in as one, create tasks, then sign in as the other and see an empty list. A free-text
      // email field would work too, but offering two fixed identities makes the comparison
      // reproducible during a presentation. Never seen outside local development — this file only
      // runs under `vite dev`/`vite build` and is never bundled into the deployed Worker.
      users: [
        { email: 'alice@example.com', name: 'Alice' },
        { email: 'bob@example.com', name: 'Bob' }
      ]
    }),
    vue(),
    cloudflare({
      // `cf` v1's Vite-plugin v2 build chain reads cloudflare.config.ts directly and emits the
      // Build Output Spec that `cf deploy --prebuilt` consumes. `cf workers types` generates
      // the matching `.cloudflare/types/index.d.ts` for standalone type checks.
    })
  ]
});
