import type { Env, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { cloudflareAccess, type PathPolicy } from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Hono environment accepted by {@link createAccessMiddleware}. It binds the Access Audience tag as
 * `ACCESS_AUD`.
 */
export type AccessAudienceEnv = Env & { Bindings: { ACCESS_AUD?: string } };

/**
 * Configuration passed to {@link createAccessMiddleware}.
 */
export interface AccessMiddlewareOptions {
  /**
   * Builds the ordered policy list for one Audience tag. The first matching policy determines the
   * action for a request path.
   */
  buildPolicies: (audience: string) => PathPolicy[];
  /**
   * Enables the toolkit's HS256 development tokens. Pass `import.meta.env.DEV` when constructing
   * Worker middleware.
   */
  enableDevTokens: boolean;
}

/**
 * Creates Cloudflare Access middleware that reads the Audience tag from `ACCESS_AUD`.
 *
 * Mount the returned middleware on the application before any routes:
 *
 * ```ts
 * export const accessMiddleware = createAccessMiddleware<AppBindings>({
 *   buildPolicies: buildAccessPolicies,
 *   enableDevTokens: import.meta.env.DEV
 * });
 *
 * app.use(accessMiddleware);
 * ```
 *
 * The middleware builds policies with the request's audience, applies a fail-closed default action,
 * and sets `Cloudflare_Access_Identity` after successful verification.
 *
 * @typeParam E Hono environment of the application this middleware is mounted on.
 * @param options Policy builder and development-token switch.
 * @returns Middleware that verifies the Access JWT and sets `Cloudflare_Access_Identity`.
 * @throws {Error} At request time when `ACCESS_AUD` is missing or empty.
 * @throws {ProblemDetailsError} At request time with `401` when a protected path is requested
 *   without a valid Access JWT for the configured audience.
 */
export function createAccessMiddleware<E extends AccessAudienceEnv>(
  options: AccessMiddlewareOptions
): MiddlewareHandler<E> {
  const middlewareByAudience = new Map<string, MiddlewareHandler>();

  /**
   * Returns the cached toolkit middleware for an Audience tag, creating it when needed.
   *
   * @param audience Audience tag every JWT must carry in its `aud` claim.
   * @returns Middleware configured for the supplied audience.
   */
  function middlewareFor(audience: string): MiddlewareHandler {
    const cached = middlewareByAudience.get(audience);
    if (cached !== undefined) {
      return cached;
    }

    const middleware = cloudflareAccess({
      defaultAction: 'block',
      enableDevTokens: options.enableDevTokens,
      policies: options.buildPolicies(audience)
    });
    middlewareByAudience.set(audience, middleware);
    return middleware;
  }

  return createMiddleware<E>(async (context, next) => {
    const audience = context.env.ACCESS_AUD;
    if (!audience) {
      throw new Error(
        'ACCESS_AUD is not bound. Run `pnpm deploy:infra` so Terraform publishes the Access '
          + 'application audience, or restore infra/local-outputs.json for local development.'
      );
    }

    return middlewareFor(audience)(context, next);
  });
}
