import { env } from 'cloudflare:workers';
import application from '../../../src/worker';

/**
 * Report the verified Cloudflare Access identity of the current visitor.
 *
 * The React client calls this after mounting for two reasons: to show who is signed in, and to know
 * which messages in a channel are its own — the message pane highlights a message when its author
 * matches this value.
 *
 * @param request Incoming identity request.
 * @returns The response produced by the Hono application: `200` with `{ email }` for a valid Access
 *   session, or an RFC 9457 `401` once the JWT is absent or expired.
 */
export async function GET(request: Request): Promise<Response> {
  return application.fetch(request, env);
}
