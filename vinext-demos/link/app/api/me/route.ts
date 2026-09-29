import { env } from 'cloudflare:workers';
import application from '../../../src/worker';

/**
 * Return the current authorized administrator identity.
 *
 * @param request Incoming identity request.
 * @returns The response produced by the Hono application.
 */
export async function GET(request: Request): Promise<Response> {
  return application.fetch(request, env);
}
