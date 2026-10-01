import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../access-policies';
import type { AppBindings } from '../bindings';

/**
 * Cloudflare Access middleware protecting every route except the public short-link redirects.
 *
 * The shared implementation resolves the `ACCESS_AUD` binding per request and memoizes the
 * underlying middleware per audience — see `@demos/worker-common`. Authenticating against this
 * demo's own audience is what stops a token minted for an unrelated Access application in the same
 * team from being accepted here, since every application in a team shares one JWKS.
 *
 * Access proves only that _some_ valid identity signed in. The additional check that the identity
 * is this demo's configured administrator lives in `./require-admin.ts`, mounted on the management
 * routes.
 */
export const accessMiddleware = createAccessMiddleware<AppBindings>({
  buildPolicies: buildAccessPolicies,
  enableDevTokens: import.meta.env.DEV
});
