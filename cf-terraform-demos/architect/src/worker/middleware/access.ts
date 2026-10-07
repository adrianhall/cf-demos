import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../access-policies.ts';
import type { AppBindings } from '../bindings.ts';

/**
 * Cloudflare Access middleware for every route in this application.
 *
 * Edge Access is not authorization on its own: every Access application in a team shares one JWKS,
 * so a token minted for an unrelated application would pass signature validation. The middleware
 * therefore re-validates the audience inside the Worker, using the audience Terraform published as
 * `ACCESS_AUD`.
 */
export const accessMiddleware = createAccessMiddleware<AppBindings>({
  buildPolicies: buildAccessPolicies,
  enableDevTokens: import.meta.env.DEV
});
