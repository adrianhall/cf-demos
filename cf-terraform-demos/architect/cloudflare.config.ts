/**
 * Single source of truth for this Worker's configuration.
 *
 * Terraform (see `infra/`) owns real infrastructure IDs (D1 database, KV namespace, custom
 * hostname, Access applications and their audience tag, Worker registration). Its
 * `postdeploy:infra:apply` npm hook (see `package.json`) runs `terraform -chdir=infra output -json >
 * infra/outputs.json` right after every successful `terraform apply`, so `infra/outputs.json`
 * always mirrors the last-applied infrastructure. This file reads that (gitignored) JSON file via
 * `@adrianhall/cloudflare-toolkit/vite`'s `requireTerraformOutputs` in production mode, so the
 * deployed Worker always matches the infrastructure Terraform actually provisioned. In local/dev
 * mode it reads the same shape from the committed `infra/local-outputs.json` instead — hermetic
 * placeholder values checked into the repository, so `cf dev` / `vite dev` / tests never touch live
 * Terraform state and stay fast and offline-friendly.
 *
 * The Worker name and hostname are read from those outputs rather than written here. That is
 * load-bearing rather than tidy: this port is deployed alongside the implementation it was ported
 * from, which still holds the shorter name on the same account, and a literal in this file would be
 * one more place a rename could miss. See `infra/providers.tf`'s `worker_name` variable.
 *
 * The `DIAGRAM_SESSIONS` Durable Object namespace is the one piece of infrastructure declared here
 * rather than in Terraform, and that is not an inconsistency. A Durable Object namespace is defined
 * by the class its Worker exports: it is provisioned by the same deploy that uploads the code and
 * retired when that code stops exporting the class. Splitting ownership — Terraform creating the
 * namespace, `cf` uploading the class — would give one resource two owners, which this repository's
 * rules forbid, so `infra/architect.tf` needs no resource and no `depends_on` edge for it. Deleting
 * the Worker in `pnpm teardown:worker` removes the namespace, and nothing is lost with it because
 * the sessions hold no durable state: every diagram lives in D1.
 */

import { bindings, defineConfig, defineWorker, exports } from 'cf/config';
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';
import { OUTPUT_KEYS, type TerraformOutputs } from './infra/outputs.ts';
import * as entrypoint from './src/worker/index.ts' with { type: 'cf-worker' };

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

      // Declares the Durable Object class this Worker defines. This entry is what replaces
      // Wrangler's `new_sqlite_classes` migration — `cf` models a namespace's lifecycle as a
      // `state` field on the export (`created` by default, plus `deleted`, `renamed`,
      // `transferred`) rather than as an append-only list of migration tags whose names can never
      // be reused. Retiring this class later is a `state: 'deleted'` entry here, not a new tag.
      //
      // `storage: 'sqlite'` selects the SQLite-backed engine, which is the current default
      // recommendation even though `DiagramSession` stores nothing at all: the session is purely a
      // live fan-out point and D1 remains the one authoritative copy of every diagram. The key
      // must match the class name exported from `src/worker/index.ts` exactly.
      exports: {
        DiagramSession: exports.durableObject({ storage: 'sqlite' })
      },

      assets: {
        // The client is a single-page application whose `/app*` boundary is a real browser
        // navigation rather than a history transition, precisely so Cloudflare Access can
        // intercept the document request before any bundle runs. `single-page-application`
        // fallback is what makes `/app/diagrams/:id` and `/s/:token` resolve to that one
        // document instead of a 404.
        notFoundHandling: 'single-page-application',
        // Only the API and the MCP endpoint are handled by Worker code. Pages are served straight
        // from the asset store, which in production means Cloudflare Access gates them at the edge
        // before any Worker invocation — the Worker is never on the critical path for a page load.
        //
        // `/mcp*` needs its own entry because it is not under `/api/`: without it every MCP
        // request falls through to the single-page-application asset fallback and is answered with
        // the application's own HTML document, which an MCP client reports as a protocol error
        // rather than as a routing mistake.
        runWorkerFirst: ['/api/*', '/mcp*']
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
        // The binding is pinned by database ID in both modes, and that is load-bearing rather than
        // cosmetic: the local D1 simulation keys its SQLite file by database ID, and
        // `cf d1 migrations apply` only accepts an ID (it rejects names and binding names
        // outright). Binding the same ID that `pnpm migrate:local` passes is therefore what makes
        // `cf dev` read the schema those migrations created.
        DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName }),
        // Disposable digest → diagram-id lookup for anonymous share resolution. D1 stays
        // authoritative for the share lifecycle, so the local simulation needs no id at all.
        SHARES: bindings.kv(isProduction ? { id: values.sharesKvNamespaceId } : {}),
        // Self-referential: the Worker that defines `DiagramSession` is also the one that talks to
        // it. `worker: values.workerName` names this same Worker, which is how a Durable Object
        // binding is expressed even when the class lives in the binding Worker's own code.
        DIAGRAM_SESSIONS: bindings.durableObject({
          worker: values.workerName,
          exportName: 'DiagramSession'
        }),
        ACCESS_AUD: bindings.text(values.accessAud),
        ADMIN_EMAIL: bindings.text(values.adminEmail),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        // The MCP handler performs its own `Host` header validation and its default allowlist
        // covers only localhost and `workers.dev`, neither of which is this demo's custom
        // hostname. Binding the Terraform `hostname` output is what keeps `POST /mcp` reachable
        // on the deployed domain — and binding it rather than writing the literal is what keeps
        // this demo's lifecycle away from the deployment it was ported from. See
        // `src/worker/mcp/server.ts`.
        PUBLIC_HOSTNAME: bindings.text(values.hostname),
        // Deliberately absent in development: its absence selects the toolkit's development logging
        // defaults without requiring an untracked `.dev.vars` file.
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
