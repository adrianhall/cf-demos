import type { CloudflareToolkitVariables } from '@adrianhall/cloudflare-toolkit/hono';
import type { LinkService } from './application/link-service';

/**
 * Request-scoped values supplied to Hono routes by the shared application composition root.
 */
export interface AppVariables extends CloudflareToolkitVariables {
  /**
   * Business-logic tier wired by `src/worker/index.ts`.
   */
  LINK_SERVICE: LinkService;
}

/**
 * Hono environment shape shared by the standalone route application and its sub-routers.
 */
export interface AppBindings {
  /**
   * Wrangler-generated Workers bindings.
   */
  Bindings: Env & { ENVIRONMENT?: string };
  /**
   * Values attached while a request passes through application middleware.
   */
  Variables: AppVariables;
}
