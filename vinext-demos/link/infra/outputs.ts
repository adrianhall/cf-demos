/**
 * @file Definitions of the Terraform outputs for the project.
 */

/**
 * TypeScript mirror of the seven outputs declared in `infra/outputs.tf`, camelCased from their
 * snake_case Terraform output names.
 */
export type TerraformOutputs = {
  /**
   * Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim
   * against.
   */
  accessAud: string;
  /**
   * Sole administrator email the Worker authorizes management requests against.
   */
  adminEmail: string;
  /**
   * Cloudflare Access team domain used for Worker-side JWT validation.
   */
  cloudflareTeamDomain: string;
  /**
   * Deployment environment name bound into the Worker.
   */
  environment: string;
  /**
   * Public custom hostname serving the demo.
   */
  hostname: string;
  /**
   * Workers KV namespace identifier backing the link repository.
   */
  linksKvNamespaceId: string;
  /**
   * Worker service name.
   */
  workerName: string;
};

/**
 * Maps `TerraformOutputs`' keys to the output names declared in `infra/outputs.tf`.
 */
export const OUTPUT_KEYS = {
  accessAud: 'access_aud',
  adminEmail: 'admin_email',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  environment: 'environment',
  hostname: 'hostname',
  linksKvNamespaceId: 'links_kv_namespace_id',
  workerName: 'worker_name'
} as const;
