import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { IdentityService } from './application/identity-service';

/**
 * Request values added by SalesBot middleware.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Application service supplied by the composition root.
   */
  IDENTITY_SERVICE: IdentityService;
}

/**
 * Hono binding and request-variable types for the Worker.
 */
export interface AppBindings {
  /**
   * Generated environment bindings plus the optional production label.
   */
  Bindings: Env & { ENVIRONMENT?: string };
  /**
   * Values set during request processing.
   */
  Variables: AppVariables;
}
