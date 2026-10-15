import { bindings, defineConfig, defineWorker, exports } from 'cf/config';
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
      // `ConversationSession` is defined by this Worker, so cf owns its Durable Object namespace
      // alongside the code that exports the class. Terraform owns D1 and the AI Gateway, but
      // splitting this namespace between Terraform and cf would give one resource two owners.
      exports: { ConversationSession: exports.durableObject({ storage: 'sqlite' }) },
      assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
        traces: { enabled: true, headSamplingRate: 0.1, persist: true }
      },
      env: {
        DB: bindings.d1({ id: values.d1DatabaseId, name: values.d1DatabaseName }),
        // Workers AI can only be reached by `GatewayInferenceClient`, which supplies the configured
        // gateway on every call. The binding alone would allow direct inference, hence the invariant
        // test that permits it in exactly that one module.
        AI: bindings.ai(),
        // Self-referential Durable Object binding: this Worker defines ConversationSession and also
        // forwards authenticated WebSocket upgrades to it.
        CONVERSATION_SESSION: bindings.durableObject({
          worker: values.workerName,
          exportName: 'ConversationSession'
        }),
        ACCESS_AUD: bindings.text(values.accessAud),
        CLOUDFLARE_TEAM_DOMAIN: bindings.text(values.cloudflareTeamDomain),
        AI_GATEWAY_ID: bindings.text(values.aiGatewayId),
        ...(production ? { ENVIRONMENT: bindings.text(values.environment) } : {})
      }
    };
  })
});
