import type { Context } from 'hono';
import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import type { AppBindings } from '../bindings';

/**
 * Read the owning user identifier for the current request from the verified Cloudflare Access
 * identity.
 *
 * This is the single place the application decides _who_ a request acts as, and it deliberately
 * reads only from the JWT that `../middleware/access.ts` validated — never from a path parameter,
 * query string, header, or request body. Every route obtains the owner through this function, so
 * there is no route-local opportunity to accept a caller-supplied identity by mistake.
 *
 * The email claim is used rather than `sub` because it is the stable, human-recognisable value the
 * demo shows in the UI and in the `user_id` column, which makes per-user isolation visible when
 * querying D1 during a demonstration. A production system that must survive a user changing their
 * email address should key rows on the immutable `sub` claim instead and treat the email purely as
 * display data.
 *
 * @param context Hono request context whose `Cloudflare_Access_Identity` variable was set by the
 *   Access middleware.
 * @returns The verified identity's email address, used as the task owner.
 * @throws {NullError} When no verified identity is present, which means this was called on a route
 *   that is not behind the Access middleware. Failing loudly is intentional: silently substituting
 *   an anonymous owner would merge every unauthenticated caller's tasks into one shared list.
 */
export function currentUserId(context: Context<AppBindings>): string {
  const identity = context.get('Cloudflare_Access_Identity');
  throwIfNull(identity, 'accessMiddleware must verify an identity before this route runs');
  return identity.email;
}
