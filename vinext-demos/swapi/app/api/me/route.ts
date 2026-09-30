import { env } from 'cloudflare:workers';
import application from '../../../src/worker';

/**
 * Report the verified Cloudflare Access identity of the current visitor.
 *
 * A delivery-tier adapter and nothing more: it obtains the Worker bindings and forwards the
 * untouched `Request`, so identity verification stays in `src/worker` rather than leaking into
 * framework routing.
 *
 * @param request Incoming identity request, forwarded verbatim.
 * @returns The response produced by the Hono application: `200` with `{ email }` for a valid Access
 *   session, or an RFC 9457 `401` once the JWT is absent or expired. The `401` rather than a
 *   redirect is what lets the banner detect an expired session (see `src/access-policies.ts`).
 */
export async function GET(request: Request): Promise<Response> {
  return application.fetch(request, env);
}
