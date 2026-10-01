import vinext from 'vinext';
import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { buildAccessPolicies } from './src/access-policies.ts';

/**
 * Vite configuration for Vinext, the Workers runtime, and local Cloudflare Access emulation.
 */
export default defineConfig({
  build: {
    rolldownOptions: {
      external: ['cloudflare:workers']
    }
  },
  plugins: [
    cloudflareAccessPlugin({
      // Build the same audience-aware policies as the Worker from the committed local output that
      // `cloudflare.config.ts` binds as `ACCESS_AUD`.
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      users: [{ email: 'admin@example.com', name: 'Administrator' }]
    }),
    vinext(),
    cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })
  ]
});
