import { bindings, defineConfig, defineWorker } from 'cf/config';
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { OUTPUT_KEYS, type TerraformOutputs } from './infra/outputs.ts';
import * as entrypoint from './src/worker/index.ts' with { type: 'cf-worker' };

/**
 * The typed, single source of truth for SalesBot's Worker configuration.
 */
export default defineConfig({
  worker: defineWorker((context) => {
    const production = context.mode === 'production';
    const values = requireTerraformOutputs<TerraformOutputs>({
      path: production ? 'infra/outputs.json' : 'infra/local-outputs.json',
      keys: OUTPUT_KEYS,
      hint: production ? 'pnpm deploy:infra' : 'restore infra/local-outputs.json'
    });

    return {
      name: values.workerName,
      entrypoint,
      compatibilityDate: '2026-10-13',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false,
      previewUrls: false,
      domains: production ? [values.hostname] : [],
      assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
        traces: { enabled: true, headSamplingRate: 0.1, persist: true }
      },
      env: {
        DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName }),
        ACCESS_AUD: bindings.text(values.accessAud),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        AI_GATEWAY_ID: bindings.text(values.aiGatewayId),
        ...(production ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
