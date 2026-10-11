import path from 'node:path';
import { defineConfig } from 'vite';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { dataWorkerSettings } from './data/worker-settings.ts';
import localOutputs from './infra/local-outputs.json' with { type: 'json' };
import { readOutputs } from './infra/outputs.ts';
import { buildAccessPolicies } from './src/application-worker/api/access-policies.ts';

/**
 * Local development identities, one per seeded role. They exist only in the local D1 seed
 * (`migrations/seed/local.sql`) and this dev-only login page; nothing here reaches a deployment.
 * `owner@example.com` is also the local `admin_email`, so it is the bootstrap owner.
 */
const DEV_USERS = [
  { email: 'owner@example.com', name: 'Olivia Owner (owner)' },
  { email: 'manager@example.com', name: 'Morgan Manager (manager)' },
  { email: 'sales@example.com', name: 'Sam Sales (sales)' },
  { email: 'delivery@example.com', name: 'Dana Delivery (delivery)' },
  { email: 'readonly@example.com', name: 'Riley Reader (read-only)' }
];

export default defineConfig(({ mode }) => ({
  plugins: [
    // Local Access emulation: signs HS256 development tokens that the Worker's real Access middleware
    // verifies with the same policy list and audience it uses in production.
    cloudflareAccessPlugin({
      policies: buildAccessPolicies(localOutputs.access_aud.value),
      users: DEV_USERS
    }),
    vue(),
    cloudflare({
      // Where local resource state lives. `cf dev` does not forward `--persist-to` to the Vite
      // delegate (it accepts only --mode/--host/--port/--local), so the location is set here. It
      // must match the directory `scripts/d1-migrate.ts` migrated: `.cloudflare/state` for
      // `pnpm start`, or the E2E harness's own directory via `IGNITE_PERSIST_TO`
      // (`scripts/e2e-server.ts`).
      persistState: { path: process.env.IGNITE_PERSIST_TO ?? '.cloudflare/state' },
      // The Data Worker runs beside the Application Worker in `cf dev` and is emitted as its own
      // Build Output entry by `vite build`, from the same settings `data/cloudflare.config.ts` uses.
      auxiliaryWorkers: [
        {
          config: dataWorkerSettings(
            readOutputs(mode),
            mode === 'production',
            path.resolve(import.meta.dirname, 'src/data-worker/index.ts')
          )
        }
      ]
    })
  ]
}));
