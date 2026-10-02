/**
 * @file TypeScript mirror of the Terraform outputs declared in `outputs.tf`, consumed by
 *   `../cloudflare.config.ts`.
 */

/**
 * The eight outputs declared in `infra/outputs.tf`, camelCased from their snake_case Terraform
 * output names.
 */
export type TerraformOutputs = {
  /**
   * Cloudflare Access Application Audience (AUD) tag the Worker validates the JWT `aud` claim
   * against.
   */
  accessAud: string;
  /**
   * Identifier of the AI Gateway every inference request is routed through, bound as
   * `AI_GATEWAY_ID`.
   */
  aiGatewayId: string;
  /**
   * Cloudflare account identifier, used only to build the AI Gateway dashboard link.
   */
  cloudflareAccountId: string;
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
   * Name of the R2 bucket Create Video stores generated video in, bound as `VIDEO_BUCKET`.
   *
   * Declared in Terraform as `r2_bucket_name` rather than a more descriptive name, because that is
   * the key the toolkit's `empty-r2-bucket --terraform` mode reads. Matching it means `pnpm
   * teardown` empties the bucket using the shared CLI rather than a demo-local script.
   */
  videoBucketName: string;
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
  aiGatewayId: 'ai_gateway_id',
  cloudflareAccountId: 'cloudflare_account_id',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  environment: 'environment',
  hostname: 'hostname',
  videoBucketName: 'r2_bucket_name',
  workerName: 'worker_name'
} as const;
