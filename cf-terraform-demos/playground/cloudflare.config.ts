/**
 * Single source of truth for this Worker's configuration.
 *
 * Terraform (see `infra/`) owns real infrastructure IDs (the AI Gateway, custom hostname, Access
 * application and its audience tag, Worker registration). Its `postdeploy:infra:apply` npm hook
 * (see `package.json`) runs `terraform -chdir=infra output -json > infra/outputs.json` right after
 * every successful `terraform apply`, so `infra/outputs.json` always mirrors the last-applied
 * infrastructure. This file reads that (gitignored) JSON file via
 * `@adrianhall/cloudflare-toolkit/vite`'s `requireTerraformOutputs` in production mode, so the
 * deployed Worker always matches the infrastructure Terraform actually provisioned. In local/dev
 * mode it reads the same shape from the committed `infra/local-outputs.json` instead — hermetic
 * placeholder values checked into the repository, so `cf dev` / `vite dev` / tests never touch live
 * Terraform state and stay fast and offline-friendly.
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

      exports: {
        // Create Video's generation runs here rather than in the request that starts it. An HTTP
        // Worker has no duration limit while the client stays connected, but when the visitor
        // closes the tab the request is cancelled and `waitUntil()` buys about thirty seconds — and
        // a render abandoned halfway has still been paid for. Durable execution is what stops this
        // panel from charging someone for a video it then discards.
        //
        // The instance also serves as the job record, which is why this demo adds no D1 table and
        // no KV namespace for job status: a second store would be a second source of truth for one
        // job's state.
        CreateVideoWorkflow: exports.workflow({ name: `${values.workerName}-create-video` }),
        // Animate Image runs durably for exactly the same reasons, and shares Create Video's
        // bucket, storage adapter, step policies, and ownership derivation. It gets its own
        // Workflow rather than a mode inside the other because the two carry different payloads
        // and apply different validation on arrival — the picture is re-verified from its own
        // bytes inside this one.
        AnimateImageWorkflow: exports.workflow({ name: `${values.workerName}-animate-image` })
      },

      assets: {
        notFoundHandling: 'single-page-application',
        // Only the API is handled by Worker code. Pages are served straight from the asset store,
        // which in production means Cloudflare Access gates them at the edge before any Worker
        // invocation — the Worker is never on the critical path for a page load.
        runWorkerFirst: ['/api/*']
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
        // Workers AI. The binding alone would happily call a model with no gateway at all, which
        // is exactly the behaviour this demo argues against; `AI_GATEWAY_ID` below is what makes
        // every call observable, and `src/worker/infrastructure/ai/gateway-inference-client.ts` is
        // the only module permitted to use this binding.
        AI: bindings.ai(),
        // Identifier of the Terraform-managed gateway. Bound in both modes and never defaulted in
        // code: the inference client refuses to construct without it, so a misconfigured deploy
        // fails loudly instead of silently falling back to AI Gateway's implicit `default`
        // gateway and scattering this demo's logs into a shared, undeletable bucket.
        AI_GATEWAY_ID: bindings.text(values.aiGatewayId),
        // Account identifier, used only to build the "open this gateway in the dashboard" link on
        // the Activity page. It is not a credential, and the account ID is already visible in
        // every dashboard URL the presenter will open.
        CLOUDFLARE_ACCOUNT_ID: bindings.text(values.cloudflareAccountId),
        ACCESS_AUD: bindings.text(values.accessAud),
        // Where Create Video keeps generated video. Bound in both modes so local development
        // exercises the same storage path as production against `cf dev`'s local simulation.
        //
        // This is the demo's first storage product, and it is here for a specific reason rather
        // than convenience: a `<video>` element seeks by issuing `Range` requests, which the
        // base64-in-JSON transport every other panel uses cannot answer. Streaming provider bytes
        // into R2 also keeps a multi-megabyte file out of the isolate's 128 MB budget. Uploaded
        // images deliberately do *not* use it — they travel in the request, as before.
        VIDEO_BUCKET: bindings.r2({ name: values.videoBucketName }),
        // The Workflow binding the API routes use to start, poll, and terminate a generation.
        VIDEO_JOBS: bindings.workflow({
          name: `${values.workerName}-create-video`,
          worker: values.workerName,
          exportName: 'CreateVideoWorkflow'
        }),
        // Animate Image's equivalent. Note what is *not* duplicated: there is no second bucket and
        // no second run store. Generated video from both panels lands in `VIDEO_BUCKET` under the
        // one `generated-video/` prefix, so a single scheduled reaper will collect both.
        ANIMATE_JOBS: bindings.workflow({
          name: `${values.workerName}-animate-image`,
          worker: values.workerName,
          exportName: 'AnimateImageWorkflow'
        }),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        // Deliberately absent in development: its absence selects the toolkit's development
        // logging defaults without requiring an untracked `.dev.vars` file.
        ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
