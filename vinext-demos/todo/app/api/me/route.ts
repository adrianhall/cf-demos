import { env } from 'cloudflare:workers';
import application from '../../../src/worker';

/**
 * Report the verified Cloudflare Access identity of the current visitor.
 *
 * @param request Incoming identity request.
 * @returns The response produced by the Hono application: `200` with `{ email }` for a valid Access
 *   session, or an RFC 9457 `401` once the JWT is absent or expired.
 */
export async function GET(request: Request): Promise<Response> {
  return application.fetch(request, env);
}
