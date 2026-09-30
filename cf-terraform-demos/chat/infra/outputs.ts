/**
 * @file TypeScript mirror of the Terraform outputs declared in `outputs.tf`, consumed by
 *   `../cloudflare.config.ts`.
 */

/**
 * The seven outputs declared in `infra/outputs.tf`, camelCased from their snake_case Terraform
 * output names.
 */
export type TerraformOutputs = {
  /**
   * Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim
   * against.
   */
  accessAud: string;
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
   * Worker service name.
   */
  workerName: string;
};

/**
 * Maps {@link TerraformOutputs}' keys to the output names declared in `infra/outputs.tf`.
 */
export const OUTPUT_KEYS = {
  accessAud: 'access_aud',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  d1DatabaseId: 'd1_database_id',
  d1DatabaseName: 'd1_database_name',
  environment: 'environment',
  hostname: 'hostname',
  workerName: 'worker_name'
} as const;
