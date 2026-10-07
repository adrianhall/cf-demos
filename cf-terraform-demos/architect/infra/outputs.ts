/**
 * @file TypeScript mirror of the Terraform outputs declared in `outputs.tf`, consumed by
 *   `../cloudflare.config.ts` and by the lifecycle scripts in `../scripts/`.
 */

/**
 * The nine outputs declared in `infra/outputs.tf`, camelCased from their snake_case Terraform
 * output names.
 */
export type TerraformOutputs = {
  /**
   * Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim
   * against.
   */
  accessAud: string;
  /**
   * Sole identity the Worker treats as the administrator.
   */
  adminEmail: string;
  /**
   * Cloudflare Access team domain used for Worker-side JWT validation.
   */
  cloudflareTeamDomain: string;
  /**
   * D1 database identifier bound to the Worker as `DB`.
   */
  d1DatabaseId: string;
  /**
   * D1 database name, used by the migration commands.
   */
  d1DatabaseName: string;
  /**
   * Deployment environment name bound into the Worker.
   */
  environment: string;
  /**
   * Public custom hostname serving the demo.
   */
  hostname: string;
  /**
   * Workers KV namespace identifier bound to the Worker as `SHARES`.
   */
  sharesKvNamespaceId: string;
  /**
   * Worker service name, resolved rather than restated by every lifecycle command.
   */
  workerName: string;
};

/**
 * Maps {@link TerraformOutputs}' keys to the output names declared in `infra/outputs.tf`.
 */
export const OUTPUT_KEYS = {
  accessAud: 'access_aud',
  adminEmail: 'admin_email',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  d1DatabaseId: 'd1_database_id',
  d1DatabaseName: 'd1_database_name',
  environment: 'environment',
  hostname: 'hostname',
  sharesKvNamespaceId: 'shares_kv_namespace_id',
  workerName: 'worker_name'
} as const;
