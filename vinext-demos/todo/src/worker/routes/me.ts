import { Hono } from 'hono';
import type { AppBindings } from '../bindings';
import { currentUserId } from './identity';

/**
 * Reports the signed-in user's verified identity, mounted at `/api/me` by `../index.ts`.
 *
 * The React client calls this after mounting to display who is signed in. It deliberately echoes
 * the server's _verified_ view of the identity rather than anything the browser knows: pages are
 * rendered by Vinext behind a Cloudflare Access application that gates the hostname at the edge, so
 * the client has no trustworthy copy of the identity of its own. This endpoint is also what the UI
 * uses to detect an expired Access session, since it returns `401` once the JWT is no longer
 * valid.
 */
export const meRouter = new Hono<AppBindings>();

/**
 * Return the verified identity's email address.
 *
 * @param context Hono request context containing the identity established by the Access middleware.
 * @returns A JSON `200` response of the form `{ "email": "user@example.com" }`.
 * @throws {NullError} When the route is mounted without the Access middleware in front of it.
 */
meRouter.get('/', (context) => context.json({ email: currentUserId(context) }));
