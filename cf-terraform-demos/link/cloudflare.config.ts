/**
 * Single source of truth for this Worker's configuration.
 *
 * Terraform (see `infra/`) owns real infrastructure IDs (KV namespace, custom hostname, Access team
 * domain, Worker registration). Its `postdeploy:infra:apply` npm hook (see `package.json`) runs
 * `terraform -chdir=infra output -json > infra/outputs.json` right after every successful
 * `terraform apply`, so `infra/outputs.json` always mirrors the last-applied infrastructure. This
 * file reads that (gitignored) JSON file via `@adrianhall/cloudflare-toolkit/vite`'s
 * `requireTerraformOutputs` in production mode, so the deployed Worker always matches the
 * infrastructure Terraform actually provisioned. In local/dev mode it reads the same shape from the
 * committed `infra/local-outputs.json` instead — hermetic placeholder values checked into the
 * repository, so `cf dev` / `vite dev` / tests never touch live Terraform state and stay fast and
 * offline-friendly.
 */

import { bindings, defineConfig, defineWorker } from 'cf/config';
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { type TerraformOutputs, OUTPUT_KEYS } from './infra/outputs.ts';
import * as entrypoint from './src/worker/index.ts' with { type: 'cf-worker' };

export default defineConfig({
  worker: defineWorker((ctx) => {
    const isProduction = ctx.mode === 'production';

    // Read the six Terraform outputs from the appropriate JSON file, validating that all six exist.
    const values: TerraformOutputs = requireTerraformOutputs<TerraformOutputs>({
      path: isProduction ? 'infra/outputs.json' : 'infra/local-outputs.json',
      keys: OUTPUT_KEYS,
      hint: isProduction
        ? 'npm run deploy:infra'
        : 'restore the committed infra/local-outputs.json fixture'
    });

    return {
      name: values.workerName,
      entrypoint,
      compatibilityDate: '2026-08-25',
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false,
      previewUrls: false,

      domains: isProduction ? [values.hostname] : [],

      assets: {
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*', '/l/*']
      },

      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: {
          enabled: true,
          headSamplingRate: 1,
          invocationLogs: true,
          persist: true
        },
        traces: {
          enabled: true,
          headSamplingRate: 0.1,
          persist: true
        }
      },

      env: {
        LINKS: bindings.kv(isProduction ? { id: values.linksKvNamespaceId } : {}),
        ADMIN_EMAIL: bindings.text(values.adminEmail),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
