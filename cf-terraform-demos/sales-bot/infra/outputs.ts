/**
 * Terraform output types consumed by the Worker configuration.
 */
export type TerraformOutputs = {
  /**
   * AI Gateway identifier reserved for the answer workflow in Phase 3.
   */
  aiGatewayId: string;
  /**
   * Cloudflare Access application audience validated by the Worker.
   */
  accessAud: string;
  /**
   * Cloudflare Access team domain used to retrieve its JWT keys.
   */
  cloudflareTeamDomain: string;
  /**
   * D1 database identifier.
   */
  d1DatabaseId: string;
  /**
   * D1 database name used by migration commands.
   */
  d1DatabaseName: string;
  /**
   * Runtime environment label.
   */
  environment: string;
  /**
   * Public hostname for the application.
   */
  hostname: string;
  /**
   * Worker service name.
   */
  workerName: string;
};

/**
 * Maps TypeScript fields to their Terraform output names.
 */
export const OUTPUT_KEYS = {
  aiGatewayId: 'ai_gateway_id',
  accessAud: 'access_aud',
  cloudflareTeamDomain: 'cloudflare_team_domain',
  d1DatabaseId: 'd1_database_id',
  d1DatabaseName: 'd1_database_name',
  environment: 'environment',
  hostname: 'hostname',
  workerName: 'worker_name'
} as const;
