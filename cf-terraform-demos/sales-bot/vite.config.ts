import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { buildAccessPolicies } from './src/access-policies.ts';

/**
 * Vite configuration, including a local Cloudflare Access emulator.
 */
export default defineConfig({
  plugins: [
    cloudflareAccessPlugin({
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      users: [
        { email: 'salesperson@example.com', name: 'Sam Salesperson' },
        { email: 'pm@example.com', name: 'Priya PM' },
        { email: 'admin@example.com', name: 'Ada Administrator' }
      ]
    }),
    vue(),
    cloudflare()
  ]
});
