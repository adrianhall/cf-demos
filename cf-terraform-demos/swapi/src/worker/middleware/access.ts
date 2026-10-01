import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../access-policies';
import type { AppBindings } from '../bindings';

/**
 * Cloudflare Access middleware for every route in this application.
 */
export const accessMiddleware = createAccessMiddleware<AppBindings>({
  buildPolicies: buildAccessPolicies,
  enableDevTokens: import.meta.env.DEV
});
