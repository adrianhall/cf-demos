import { env } from 'cloudflare:workers';
import application from '../../../../src/worker';

/**
 * Adapt a Vinext route request to the standalone Hono chat application.
 *
 * This is a delivery-tier adapter and nothing more: it obtains the Worker bindings and forwards the
 * untouched `Request`, so authorization, validation, and domain logic stay in `src/worker` rather
 * than leaking into framework routing. It constructs no repository and reads no binding itself.
 *
 * An optional catch-all segment (`[[...segments]]`) is used so one handler covers `/api/channels`,
 * `/api/channels/:channel`, and `/api/channels/:channel/socket`. The segments are deliberately not
 * inspected here — Hono re-parses the original URL, which keeps a single routing table for the API
 * instead of splitting it across the framework and the application.
 *
 * @param request Incoming API request, forwarded verbatim.
 * @returns The response produced by the Hono application.
 */
async function handle(request: Request): Promise<Response> {
  return application.fetch(request, env);
}

/**
 * List the channel directory, or open a participant's WebSocket connection to one channel.
 *
 * Both live on `GET` because the upgrade is a `GET` by definition: a WebSocket handshake is an
 * ordinary HTTP request until the server answers `101`. Routing it through a normal route handler
 * rather than intercepting it in the Worker entrypoint is what keeps Vinext the owner of every path
 * — see `src/worker-entry.ts` for the one export that genuinely cannot work that way.
 *
 * @param request Incoming API request.
 * @returns A JSON `200` response listing every channel, or — for `/api/channels/:channel/socket` —
 *   a `101 Switching Protocols` response whose `webSocket` is handed to the browser. A non-upgrade
 *   request to the socket path receives an RFC 9457 `426`.
 */
export const GET = handle;

/**
 * Create a channel.
 *
 * @param request Incoming API request.
 * @returns A JSON `201` response containing the created channel, or an RFC 9457 error when the name
 *   is malformed (`422`) or already taken (`409`).
 */
export const POST = handle;

/**
 * Remove a channel and everything said in it.
 *
 * @param request Incoming API request.
 * @returns An empty `204` response, or an RFC 9457 `404` when no such channel exists.
 */
export const DELETE = handle;
