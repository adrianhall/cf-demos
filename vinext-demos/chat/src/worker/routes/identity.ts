import type { Context } from 'hono';
import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import type { AppBindings } from '../bindings';

/**
 * Read the acting participant for the current request from the verified Cloudflare Access identity.
 *
 * This is the single place the application decides _who_ a request acts as, and it deliberately
 * reads only from the JWT that `../middleware/access.ts` validated — never from a path parameter,
 * query string, header, or request body. Every route obtains the participant through this function,
 * so there is no route-local opportunity to accept a caller-supplied identity by mistake.
 *
 * It is also the value handed to the room when a participant joins, which makes this function the
 * root of the demo's authorship guarantee: every message's author traces back through the socket
 * attachment to exactly this claim.
 *
 * The email claim is used rather than `sub` because it is the value the UI displays beside each
 * message, and seeing real identities next to messages is what makes the demo legible. A production
 * system that must survive a user changing their email address should key on the immutable `sub`
 * claim and treat the email purely as display data.
 *
 * @param context Hono request context whose `Cloudflare_Access_Identity` variable was set by the
 *   Access middleware.
 * @returns The verified identity's email address.
 * @throws {NullError} When no verified identity is present, which means this was called on a route
 *   that is not behind the Access middleware. Failing loudly is intentional: silently substituting
 *   an anonymous participant would attribute messages to nobody.
 */
export function currentParticipant(context: Context<AppBindings>): string {
  const identity = context.get('Cloudflare_Access_Identity');
  throwIfNull(identity, 'accessMiddleware must verify an identity before this route runs');
  return identity.email;
}
