import type { Context, Env } from 'hono';
import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import type {
  CloudflareAccessIdentity,
  CloudflareToolkitVariables
} from '@adrianhall/cloudflare-toolkit/hono';

/**
 * Hono environment accepted by the identity accessors: any environment whose `Variables` include
 * the toolkit's verified Access identity.
 */
export type IdentityEnv = Env & { Variables: CloudflareToolkitVariables };

/**
 * Reads the full verified Cloudflare Access identity for the current request.
 *
 * Only usable on a route mounted behind `accessMiddleware`:
 *
 * ```ts
 * const identity = currentIdentity(context);
 * context.var.LOGGER.info('export_requested', { sub: identity.sub });
 * ```
 *
 * The value comes from the validated JWT alone. Never read an identity from a path parameter, query
 * string, header, or request body instead.
 *
 * @param context Hono request context whose `Cloudflare_Access_Identity` variable was set by the
 *   Access middleware.
 * @returns The verified identity, carrying its `email`, `sub`, and credential `source`.
 * @throws {NullError} When no verified identity is present, meaning the route is not behind the
 *   Access middleware.
 */
export function currentIdentity<E extends IdentityEnv>(
  context: Context<E>
): CloudflareAccessIdentity {
  const identity = context.get('Cloudflare_Access_Identity');
  throwIfNull(identity, 'accessMiddleware must verify an identity before this route runs');
  return identity;
}

/**
 * Reads the verified Cloudflare Access identity's email address for the current request.
 *
 * This is the value demos use as the per-user key, so a route derives its owner in one call:
 *
 * ```ts
 * todosRouter.get('/', async (context) =>
 *   context.json({ todos: await service.list(currentIdentityEmail(context)) })
 * );
 * ```
 *
 * Prefer `sub` (via {@link currentIdentity}) when storing an owner that must survive a user
 * changing their email address; the email is used here because it is human-recognisable in a
 * demonstration.
 *
 * @param context Hono request context whose `Cloudflare_Access_Identity` variable was set by the
 *   Access middleware.
 * @returns The verified identity's email address.
 * @throws {NullError} When no verified identity is present, meaning the route is not behind the
 *   Access middleware.
 */
export function currentIdentityEmail<E extends IdentityEnv>(context: Context<E>): string {
  return currentIdentity(context).email;
}
