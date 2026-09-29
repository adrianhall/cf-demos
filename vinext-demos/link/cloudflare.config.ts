/**
 * Single source of truth for this Worker's configuration.
 *
 * Terraform (see `infra/`) owns the real infrastructure identifiers (KV namespace, custom hostname,
 * Access team domain, Worker registration). Its `postdeploy:infra:apply` npm hook writes `terraform
 * -chdir=infra output -json` to the gitignored `infra/outputs.json`, so that file always mirrors
 * the last applied infrastructure. Production reads it through
 * `@adrianhall/cloudflare-toolkit/vite`'s `requireTerraformOutputs`; local development and tests
 * read the committed `infra/local-outputs.json` placeholders instead, so `vite dev` stays hermetic
 * and offline-friendly.
 *
 * Vinext supplies the Worker entrypoint: `vinext/server/app-router-entry` serves the React App
 * Router pages and the `app/api/*` and `app/l/*` route handlers that delegate to the Hono
 * application in `src/worker`.
 */

import { bindings, defineConfig, defineWorker } from 'cf/config';
import * as entrypoint from 'vinext/server/app-router-entry' with { type: 'cf-worker' };
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { type TerraformOutputs, OUTPUT_KEYS } from './infra/outputs.ts';

export default defineConfig({
  worker: defineWorker((ctx) => {
    const isProduction = ctx.mode === 'production';

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

      // Vinext owns routing for every path, so static assets never shadow a route handler.
      assets: { notFoundHandling: 'none' },

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
