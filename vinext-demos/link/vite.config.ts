import vinext from 'vinext';
import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { accessPolicies } from './src/access-policies.ts';

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
      policies: accessPolicies,
      users: [{ email: 'admin@example.com', name: 'Administrator' }]
    }),
    vinext(),
    cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })
  ]
});
