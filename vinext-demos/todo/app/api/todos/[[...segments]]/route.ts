import { env } from 'cloudflare:workers';
import application from '../../../../src/worker';

/**
 * Adapt a Vinext route request to the standalone Hono task application.
 *
 * This is a delivery-tier adapter and nothing more: it obtains the Worker bindings and forwards the
 * untouched `Request`, so authorization, validation, and domain logic stay in `src/worker` rather
 * than leaking into framework routing. It constructs no repository and reads no binding itself.
 *
 * An optional catch-all segment (`[[...segments]]`) is used so one handler covers `/api/todos`,
 * `/api/todos/completed`, and `/api/todos/:id`. The segments are deliberately not inspected here —
 * Hono re-parses the original URL, which keeps a single routing table for the API instead of
 * splitting it across the framework and the application.
 *
 * @param request Incoming API request, forwarded verbatim.
 * @returns The response produced by the Hono application.
 */
async function handle(request: Request): Promise<Response> {
  return application.fetch(request, env);
}

/**
 * List the signed-in user's tasks.
 *
 * @param request Incoming API request.
 * @returns A JSON `200` response containing that user's tasks, newest first.
 */
export const GET = handle;

/**
 * Create a task for the signed-in user.
 *
 * @param request Incoming API request.
 * @returns A JSON `201` response containing the created task, or an RFC 9457 error.
 */
export const POST = handle;

/**
 * Rename or toggle completion of one of the signed-in user's tasks.
 *
 * @param request Incoming API request.
 * @returns A JSON `200` response containing the updated task, or an RFC 9457 error.
 */
export const PATCH = handle;

/**
 * Delete one task, or every completed task.
 *
 * @param request Incoming API request.
 * @returns An empty `204` response, or an RFC 9457 error.
 */
export const DELETE = handle;
