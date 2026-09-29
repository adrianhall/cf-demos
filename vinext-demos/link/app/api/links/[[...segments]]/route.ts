import { env } from 'cloudflare:workers';
import application from '../../../../src/worker';

/**
 * Adapt a Vinext route request to the existing Hono link-management application.
 *
 * @param request Incoming API request.
 * @returns The response produced by the Hono application.
 */
async function handle(request: Request): Promise<Response> {
  return application.fetch(request, env);
}

/**
 * List or create short links.
 *
 * @param request Incoming API request.
 * @returns The management API response.
 */
export const GET = handle;

/**
 * Create a short link.
 *
 * @param request Incoming API request.
 * @returns The management API response.
 */
export const POST = handle;

/**
 * Replace a short link destination.
 *
 * @param request Incoming API request.
 * @returns The management API response.
 */
export const PUT = handle;

/**
 * Delete a short link.
 *
 * @param request Incoming API request.
 * @returns The management API response.
 */
export const DELETE = handle;
