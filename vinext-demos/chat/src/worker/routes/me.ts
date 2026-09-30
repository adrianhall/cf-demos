import { Hono } from 'hono';
import type { AppBindings } from '../bindings';
import { currentParticipant } from './identity';

/**
 * Reports the signed-in participant's verified identity, mounted at `/api/me` by `../index.ts`.
 *
 * The SPA calls this after mounting for two reasons: to show who is signed in, and to know which
 * messages in a channel are its own — the message pane highlights a message when its author matches
 * this value. It deliberately echoes the server's _verified_ view of the identity rather than
 * anything the browser knows: pages are served by the `ASSETS` binding and gated by Cloudflare
 * Access at the edge, so the client has no trustworthy copy of the identity of its own.
 *
 * This endpoint is also what the UI uses to detect an expired Access session, since it returns
 * `401` once the JWT is no longer valid.
 */
export const meRouter = new Hono<AppBindings>();

/**
 * Return the verified identity's email address.
 *
 * @param context Hono request context containing the identity established by the Access middleware.
 * @returns A JSON `200` response of the form `{ "email": "user@example.com" }`.
 * @throws {NullError} When the route is mounted without the Access middleware in front of it.
 */
meRouter.get('/', (context) => context.json({ email: currentParticipant(context) }));
