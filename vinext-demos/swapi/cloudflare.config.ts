/**
 * Single source of truth for this Worker's configuration.
 *
 * Terraform (see `infra/`) owns real infrastructure IDs (D1 database, custom hostname, Access
 * application and its audience tag, Worker registration). Its `postdeploy:infra:apply` npm hook
 * (see `package.json`) runs `terraform -chdir=infra output -json > infra/outputs.json` right after
 * every successful `terraform apply`, so `infra/outputs.json` always mirrors the last-applied
 * infrastructure. This file reads that (gitignored) JSON file via
 * `@adrianhall/cloudflare-toolkit/vite`'s `requireTerraformOutputs` in production mode, so the
 * deployed Worker always matches the infrastructure Terraform actually provisioned. In local/dev
 * mode it reads the same shape from the committed `infra/local-outputs.json` instead — hermetic
 * placeholder values checked into the repository, so `cf dev` / `vite dev` / tests never touch live
 * Terraform state and stay fast and offline-friendly.
 *
 * Vinext supplies the Worker entrypoint: `vinext/server/app-router-entry` serves the React App
 * Router pages, the `app/api/**` route handlers, and the `app/graphql` route handler — all of which
 * delegate to the Hono application in `src/worker`.
 *
 * Note what is deliberately absent compared with the `cf-terraform-demos/swapi` sibling: there is
 * no `runWorkerFirst` list. That demo serves a static single-page application from the asset store
 * and has to name the two paths (`/graphql*`, `/api/*`) the Worker must answer instead. Here every
 * path is a Vinext route, so the Worker runs for all of them and the asset store must never be
 * allowed to answer first.
 */

import { bindings, defineConfig, defineWorker } from 'cf/config';
import * as entrypoint from 'vinext/server/app-router-entry' with { type: 'cf-worker' };
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { OUTPUT_KEYS, type TerraformOutputs } from './infra/outputs.ts';

export default defineConfig({
  worker: defineWorker((ctx) => {
    const isProduction = ctx.mode === 'production';

    // Read the Terraform outputs from the appropriate JSON file, validating that all of them exist.
    const values: TerraformOutputs = requireTerraformOutputs<TerraformOutputs>({
      path: isProduction ? 'infra/outputs.json' : 'infra/local-outputs.json',
      keys: OUTPUT_KEYS,
      hint: isProduction
        ? 'pnpm deploy:infra'
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

      // Vinext owns routing for every path — pages are server-rendered rather than served from the
      // asset store — so static assets must never shadow a page, an `app/api/**` route handler, or
      // the `app/graphql` handler that serves the GraphiQL console.
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
        // The binding is pinned by database ID in both modes, and that is load-bearing rather than
        // cosmetic: the local D1 simulation keys its SQLite file by database ID, and
        // `cf d1 migrations apply` only accepts an ID (it rejects names and binding names
        // outright). Binding the same ID that `pnpm migrate:local` passes is therefore what makes
        // `cf dev` read the schema and seed data those migrations created. In production the ID is
        // the real database Terraform provisioned; in development it is the fixed placeholder UUID
        // in `infra/local-outputs.json`. See README.md's "Local database migrations" section.
        DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName }),
        ACCESS_AUD: bindings.text(values.accessAud),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        // Deliberately absent in development: its absence selects the toolkit's development logging
        // defaults without requiring an untracked `.dev.vars` file.
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
