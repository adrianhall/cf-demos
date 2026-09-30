import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { cloudflareAccess } from '@adrianhall/cloudflare-toolkit/hono';
import { buildAccessPolicies } from '../../access-policies';
import type { AppBindings } from '../bindings';

/**
 * Cached middleware instances, keyed by the Access Audience tag they were built for.
 *
 * `cloudflareAccess` fetches and caches the team's JWKS internally, so rebuilding it per request
 * would discard that cache and add a JWKS round-trip to every call. There is exactly one audience
 * value per deployment, so this map holds exactly one entry in practice; keying by audience simply
 * makes the cache correct by construction rather than relying on that.
 *
 * The handlers are held as Hono's unparameterised `MiddlewareHandler` rather than
 * `MiddlewareHandler<AppBindings>`. The toolkit types its handler with only the `AuthVariables` it
 * sets and no `Bindings` at all, and Hono's context setter is invariant in its environment, so the
 * two named environments are not mutually assignable even though this application's context is a
 * superset. Hono's default environment is the documented escape hatch for exactly this composition,
 * and it avoids the `as unknown as` double cast the alternative would need.
 */
const middlewareByAudience = new Map<string, MiddlewareHandler>();

/**
 * Build (or reuse) the Access middleware for one Audience tag.
 *
 * @param audience Access Application Audience tag every JWT must carry in its `aud` claim.
 * @returns The memoized middleware for that audience.
 */
function middlewareFor(audience: string): MiddlewareHandler {
  const cached = middlewareByAudience.get(audience);
  if (cached !== undefined) {
    return cached;
  }

  const middleware = cloudflareAccess({
    defaultAction: 'block',
    enableDevTokens: import.meta.env.DEV,
    policies: buildAccessPolicies(audience)
  });
  middlewareByAudience.set(audience, middleware);
  return middleware;
}

/**
 * Cloudflare Access middleware for every route in this application.
 *
 * It resolves the underlying middleware per request rather than at module scope because the
 * Audience tag is a Worker binding (`ACCESS_AUD`, produced by Terraform — see `infra/outputs.tf`),
 * and bindings are only readable from a request context. The constructed middleware is memoized in
 * {@link middlewareByAudience}, so this costs one map lookup per request and the JWKS cache inside
 * `cloudflareAccess` survives between requests.
 *
 * Two independent controls protect this application, and both are required:
 *
 * 1. `defaultAction: 'block'` with `authenticate: true` policies, so a request without a valid
 *    Cloudflare Access JWT is rejected with an RFC 9457 `401` — a path this application never
 *    accidentally opens, because an unmatched path blocks rather than bypasses.
 * 2. The `audience` carried by every policy (see `src/access-policies.ts`), so a JWT must have been
 *    minted for _this_ Access application. Every application in a Cloudflare Access team shares one
 *    JWKS, so signature validation alone would also accept a token issued for an unrelated
 *    application in the same team. This is the defence-in-depth check that makes edge-level Access
 *    gating non-load-bearing on its own.
 *
 * Unlike the sibling `link` demo there is no administrator allowlist, and unlike `todo` there is no
 * per-identity data boundary below this middleware: the dataset is identical for every caller, so
 * any identity the Access application admits gets the same read-only view. Authentication here
 * bounds _who_ may spend the endpoint's compute, not what they may see. That changes when the
 * planned data editor lands, and its mutations will need an authorization check of their own rather
 * than relying on this one.
 *
 * `enableDevTokens` is gated on `import.meta.env.DEV`, which Vite replaces with the literal `false`
 * in a production build, so the deployed Worker cannot be made to trust a forgeable HS256
 * development token even if one is presented.
 *
 * @throws {Error} When `ACCESS_AUD` is missing or empty, which would otherwise silently disable
 *   audience validation and reopen cross-application token replay. Failing the request is the safe
 *   outcome: a misconfigured deployment must not serve traffic with a weaker check than intended.
 */
export const accessMiddleware = createMiddleware<AppBindings>(async (context, next) => {
  const audience = context.env.ACCESS_AUD;
  if (!audience) {
    throw new Error(
      'ACCESS_AUD is not bound. Run `pnpm deploy:infra` so Terraform publishes the Access '
        + 'application audience, or restore infra/local-outputs.json for local development.'
    );
  }

  return middlewareFor(audience)(context, next);
});
