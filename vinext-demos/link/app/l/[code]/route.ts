import { env } from 'cloudflare:workers';
import application from '../../../src/worker';

/**
 * Resolve a public short-link redirect.
 *
 * @param request Incoming public redirect request.
 * @returns The redirect or RFC 9457 error response from the Hono application.
 */
export async function GET(request: Request): Promise<Response> {
  return application.fetch(request, env);
}
