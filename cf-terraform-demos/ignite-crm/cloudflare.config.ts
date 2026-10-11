/**
 * Application Worker (`ignite-crm-application`) configuration: SPA assets plus the Hono API.
 *
 * Terraform (see `infra/`) owns infrastructure; its `postdeploy:infra:apply` hook writes the
 * ignored `infra/outputs.json`, which production mode reads. Every other mode reads the committed
 * placeholder `infra/local-outputs.json`, so `cf dev`, type generation, and tests never touch live
 * Terraform state.
 *
 * The Data Worker is configured in `data/cloudflare.config.ts`. Binding to that definition (rather
 * than to a bare Worker name) is what types `DATA_SERVICE` as `Fetcher<DataEntrypoint>`: the
 * generated types follow the reference to the Data Worker's entrypoint module.
 */

import { bindings, defineConfig, defineWorker } from 'cf/config';
import { dataWorker } from './data/cloudflare.config.ts';
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, OBSERVABILITY } from './data/worker-settings.ts';
import { readOutputs } from './infra/outputs.ts';
import * as entrypoint from './src/application-worker/index.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: defineWorker((ctx) => {
    const isProduction = ctx.mode === 'production';
    const values = readOutputs(ctx.mode);

    return {
      name: values.applicationWorkerName,
      entrypoint,
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: COMPATIBILITY_FLAGS,
      workersDev: false,
      previewUrls: false,

      domains: isProduction ? [values.applicationHostname] : [],

      assets: {
        notFoundHandling: 'single-page-application',
        // Only the API reaches Worker code; pages are served from the asset store behind the edge
        // Access application. `/mcp` is deliberately absent: it is reserved for a later release and
        // has no handler, so it must not be routed to Worker code yet.
        runWorkerFirst: ['/api/*']
      },

      observability: OBSERVABILITY,

      env: {
        // The one and only route to business state. The Application Worker never receives D1.
        DATA_SERVICE: bindings.worker({ worker: dataWorker }),
        ACCESS_AUD: bindings.text(values.accessAud),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        // Absent in development: selects the toolkit's development logging defaults without a
        // `.dev.vars` file.
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
