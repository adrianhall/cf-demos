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
 * Unlike the sibling `todo` and `link` demos, the entrypoint is `src/worker-entry.ts` rather than
 * `vinext/server/app-router-entry` directly. That module re-exports Vinext's handler unchanged and
 * adds the one export Vinext cannot provide: the `ChatRoom` class. See its file comment for why the
 * indirection is required rather than stylistic.
 *
 * The `CHAT_ROOM` Durable Object namespace is the one piece of infrastructure declared here rather
 * than in Terraform, and that is not an inconsistency. A Durable Object namespace is defined by the
 * class its Worker exports: it is provisioned by the same deploy that uploads the code and retired
 * when that code stops exporting the class. Splitting ownership — Terraform creating the namespace,
 * `cf` uploading the class — would give one resource two owners, which this repository's rules
 * forbid. Deleting the Worker in `pnpm teardown:worker` removes the namespace and every channel's
 * stored conversation along with it.
 */

import { bindings, defineConfig, defineWorker, exports } from 'cf/config';
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { OUTPUT_KEYS, type TerraformOutputs } from './infra/outputs.ts';
import * as entrypoint from './src/worker-entry.ts' with { type: 'cf-worker' };

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

      // Declares the Durable Object class this Worker defines. `storage: 'sqlite'` selects the
      // SQLite-backed engine, which is what gives each room the `ctx.storage.sql` API its message
      // history is built on — the legacy key-value engine has no SQL surface at all. The key must
      // match the class name exported from `src/worker-entry.ts` exactly.
      exports: {
        ChatRoom: exports.durableObject({ storage: 'sqlite' })
      },

      // Vinext owns routing for every path — pages are server-rendered rather than served from the
      // asset store — so static assets must never shadow a page or an `app/api/**` route handler.
      // That includes the WebSocket upgrade at `/api/channels/:channel/socket`, which is an
      // ordinary route handler and would be unreachable if asset routing could claim it first.
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
        // `cf dev` read the schema those migrations created. In production the ID is the real
        // database Terraform provisioned; in development it is the fixed placeholder UUID in
        // `infra/local-outputs.json`. See README.md's "Local database migrations" section.
        DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName }),
        // Self-referential: the Worker that defines `ChatRoom` is also the one that talks to it.
        // `worker: values.workerName` names this same Worker, which is how a Durable Object
        // binding is expressed even when the class lives in the binding Worker's own code.
        CHAT_ROOM: bindings.durableObject({ worker: values.workerName, exportName: 'ChatRoom' }),
        ACCESS_AUD: bindings.text(values.accessAud),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        // Deliberately absent in development: its absence selects the toolkit's development logging
        // defaults without requiring an untracked `.dev.vars` file.
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
