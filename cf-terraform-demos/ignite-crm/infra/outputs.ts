/**
 * @file TypeScript mirror of the Terraform outputs declared in `outputs.tf`, consumed by both
 *   Worker configurations (`../cloudflare.config.ts` and `../data/cloudflare.config.ts`) and by the
 *   lifecycle scripts in `../scripts/`.
 */

import path from 'node:path';
import { requireTerraformOutputs } from '@adrianhall/cloudflare-toolkit/vite';

/**
 * Every output declared in `infra/outputs.tf`, camelCased from its snake_case Terraform name.
 */
export type TerraformOutputs = {
  /**
   * Cloudflare Access Application Audience (AUD) tag the Application Worker validates every JWT's
   * `aud` claim against.
   */
  /**
   * AI Gateway identifier used by the chat model provider.
   */
  aiGatewayId: string;
  accessAud: string;
  /**
   * Repository-root `ADMIN_EMAIL`, bound into the Data Worker as the bootstrap owner identity.
   */
  adminEmail: string;
  /**
   * Public custom hostname serving the SPA and API.
   */
  applicationHostname: string;
  /**
   * Application Worker service name.
   */
  applicationWorkerName: string;
  /**
   * Cloudflare Access team domain used for Worker-side JWT validation.
   */
  cloudflareTeamDomain: string;
  /**
   * D1 database identifier, read by the repository-root migration helper.
   */
  d1DatabaseId: string;
  /**
   * D1 database identifier bound to the Data Worker as `DATA_DB` (same value as `d1DatabaseId`,
   * published under the specification's name).
   */
  dataD1DatabaseId: string;
  /**
   * D1 database name.
   */
  dataD1DatabaseName: string;
  /**
   * Data Worker service name, the target of the Application Worker's `DATA_SERVICE` binding.
   */
  dataWorkerName: string;
  /**
   * Deployment environment name bound into both Workers.
   */
  environment: string;
};

/**
 * Maps {@link TerraformOutputs}' keys to the output names declared in `infra/outputs.tf`.
 */
export const OUTPUT_KEYS = {
  aiGatewayId: 'ai_gateway_id',
  accessAud: 'access_aud',
  adminEmail: 'admin_email',
  applicationHostname: 'application_hostname',
  applicationWorkerName: 'application_worker_name',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  d1DatabaseId: 'd1_database_id',
  dataD1DatabaseId: 'data_d1_database_id',
  dataD1DatabaseName: 'data_d1_database_name',
  dataWorkerName: 'data_worker_name',
  environment: 'environment'
} as const;

/**
 * Read the Terraform outputs appropriate for a configuration mode.
 *
 * Production reads the ignored `infra/outputs.json` written after `terraform apply`; every other
 * mode reads the committed placeholder `infra/local-outputs.json`, so local development and tests
 * never touch live Terraform state.
 *
 * The path is resolved from this file rather than from `process.cwd()`, because the Data Worker's
 * types are generated with `data/` as the working directory while every other command runs from the
 * demo root.
 *
 * @param mode The `cf`/Vite configuration mode (`production` selects live outputs).
 * @returns Every output, validated to exist and be a string.
 * @throws {Error} When the selected outputs file is missing or lacks an output, with a hint naming
 *   the command that restores it.
 */
export function readOutputs(mode: string | undefined): TerraformOutputs {
  const isProduction = mode === 'production';
  return requireTerraformOutputs<TerraformOutputs>({
    path: path.resolve(import.meta.dirname, isProduction ? 'outputs.json' : 'local-outputs.json'),
    keys: OUTPUT_KEYS,
    hint: isProduction
      ? 'pnpm deploy:infra'
      : 'restore the committed infra/local-outputs.json fixture'
  });
}
