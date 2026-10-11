/**
 * @file Shared Data Worker settings used by both `data/cloudflare.config.ts` (types, deploy) and
 *   the Vite `auxiliaryWorkers` entry in `../vite.config.ts` (local development and build). Two
 *   callers exist because the Cloudflare Vite plugin reads only the demo-root
 *   `cloudflare.config.ts` itself; an auxiliary Worker must be handed to it as a configuration
 *   object. Keeping every setting in this one function means the Worker that `cf dev` runs, the
 *   Worker that `vite build` emits, and the Worker whose types `cf workers types` generates cannot
 *   drift apart. Only the `entrypoint` differs: `cloudflare.config.ts` passes the module namespace
 *   imported with `{ type: 'cf-worker' }` (so the Application Worker's `DATA_SERVICE` binding is
 *   typed from the real class), while Vite receives the equivalent file path.
 */

import { bindings } from 'cf/config';
import type { TerraformOutputs } from '../infra/outputs.ts';

/**
 * Compatibility date pinned for both Workers. Dates on or after 2026-04-21 enable enhanced RPC
 * error serialization, which is what lets a `ServiceError`'s `code`, `retryable`, and `requestId`
 * properties survive the service-binding hop.
 */
export const COMPATIBILITY_DATE = '2026-10-07';

/**
 * Compatibility flags shared by both Workers.
 */
export const COMPATIBILITY_FLAGS = ['nodejs_compat'];

/**
 * Structured observability settings shared by both Workers, mirrored in Terraform's
 * `cloudflare_worker` resources so neither tool reports drift.
 */
export const OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
  traces: { enabled: true, headSamplingRate: 0.1, persist: true }
} as const;

/**
 * Build the Data Worker configuration for one mode.
 *
 * @param values Terraform outputs for the mode (live or committed placeholders).
 * @param isProduction Whether this is a production build, which binds `ENVIRONMENT`.
 * @param entrypoint The Data Worker module: a `cf-worker` namespace import or an equivalent path.
 * @returns A Worker configuration object accepted by both `defineWorker` and the Vite plugin.
 */
export function dataWorkerSettings<TEntrypoint>(
  values: TerraformOutputs,
  isProduction: boolean,
  entrypoint: TEntrypoint
) {
  return {
    name: values.dataWorkerName,
    entrypoint,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
    // Private RPC service: no workers.dev hostname, no preview URLs, and no custom domain. The only
    // route in is the Application Worker's `DATA_SERVICE` service binding.
    workersDev: false,
    previewUrls: false,
    observability: OBSERVABILITY,
    env: dataWorkerEnv(values, isProduction)
  };
}

/**
 * Build the Data Worker's bindings for one mode.
 *
 * Separate from {@link dataWorkerSettings} so Data Worker code can derive its `Env` type from this
 * definition with `InferEnv` without a circular reference through its own entrypoint module.
 *
 * @param values Terraform outputs for the mode.
 * @param isProduction Whether this is a production build, which binds `ENVIRONMENT`.
 * @returns The binding map.
 */
export function dataWorkerEnv(values: TerraformOutputs, isProduction: boolean) {
  return {
    // Pinned by ID in both modes: the local D1 simulation keys its SQLite file by ID, and the
    // repository-root migration helper passes the same ID from the same outputs file.
    DATA_DB: bindings.d1({ id: values.dataD1DatabaseId, name: values.dataD1DatabaseName }),
    // Bootstrap owner identity. Only consulted on the first resolveActor() for this email.
    ADMIN_EMAIL: bindings.text(values.adminEmail),
    // Absent in development so the toolkit's development logging defaults apply without a
    // `.dev.vars` file.
    ...(isProduction ? { ENVIRONMENT: bindings.text(values.environment) } : {})
  };
}
