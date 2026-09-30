import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { buildAccessPolicies } from './src/access-policies.ts';

export default defineConfig({
  plugins: [
    // Registered before `cloudflare()` on purpose. Its connect middleware must run ahead of the
    // request-to-workerd dispatch handler so an emulated Access identity is attached before the
    // Worker sees the request — including on the WebSocket upgrade, which is an ordinary HTTP
    // request until the moment it is accepted.
    cloudflareAccessPlugin({
      // The same policy list the Worker enforces, including its audience, built from the same
      // committed local placeholder that `cloudflare.config.ts` binds as `ACCESS_AUD`. Sharing one
      // definition means a local sign-in exercises the identical audience check the deployed
      // Worker performs, rather than a weaker development-only variant.
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      // Two selectable identities, because the behaviour this demo teaches needs two people in a
      // room: sign in as one in a normal window and the other in a private window, and watch a
      // message posted by one appear instantly for the other, attributed correctly. A free-text
      // email field would work too, but fixed identities make the demonstration reproducible.
      // Never seen outside local development — this file only runs under `vite dev`/`vite build`
      // and is never bundled into the deployed Worker.
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
