import { Hono } from 'hono';
import { throwIfNull } from '@adrianhall/cloudflare-toolkit/guards';
import type { AppBindings } from '../bindings';

/**
 * Reports the signed-in user's verified identity, mounted at `/api/me` by `../index.ts` and reached
 * through the `app/api/me/route.ts` adapter.
 *
 * The explorer's banner calls this after mounting so it can show who is signed in (see UISPEC §4
 * and §10). It deliberately echoes the _server's_ verified view of the identity rather than
 * anything the browser believes: Cloudflare Access gates the hostname at the edge, so the client
 * never sees the JWT and has no trustworthy copy of the identity of its own.
 *
 * Unlike the sibling `todo` demo, this identity is display-only. Every authenticated caller reads
 * exactly the same dataset, so nothing here is an authorization input — a distinction UISPEC §10
 * asks the UI to respect, and one that will change when the planned editor adds mutations.
 *
 * It is also how the UI notices an expired Access session: once the JWT is no longer valid this
 * answers `401` rather than redirecting, because the policy for `/api/*` sets `redirect: false`
 * (see `src/access-policies.ts`).
 */
export const meRouter = new Hono<AppBindings>();

/**
 * Return the verified identity's email address.
 *
 * @returns A JSON `200` response of the form `{ "email": "user@example.com" }`.
 * @throws {NullError} When the route is mounted without the Access middleware in front of it.
 *   Failing loudly is intentional: reporting an anonymous identity would make the banner claim the
 *   visitor is signed in as nobody, rather than revealing the misconfiguration.
 */
meRouter.get('/', (context) => {
  const identity = context.get('Cloudflare_Access_Identity');
  throwIfNull(identity, 'accessMiddleware must verify an identity before this route runs');

  return context.json({ email: identity.email });
});
