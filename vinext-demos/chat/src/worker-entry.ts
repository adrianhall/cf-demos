/**
 * @file The Worker's module entrypoint, named in `cloudflare.config.ts`. It does two things Vinext
 *   cannot do for itself, and nothing else. **1. It exports the Durable Object class.** A Durable
 *   Object namespace is declared by a _named class export on the Worker's entry module_ —
 *   `exports.durableObject` in `cloudflare.config.ts` names `ChatRoom`, and the deploy fails if the
 *   uploaded entry module does not export a class by exactly that name. Vinext's own entry module
 *   exports only its handler, and cannot be asked to re-export an application's class, so the
 *   application supplies an entry module that exports both. The sibling `todo` and `link` demos
 *   need nothing of the kind and name `vinext/server/app-router-entry` directly. **2. It dispatches
 *   WebSocket upgrades straight to the API.** This is a documented workaround for a Vinext
 *   limitation rather than a design preference — see {@link fetch} and README.md's "Why the
 *   WebSocket upgrade bypasses the Vinext router".
 */

import appRouter from 'vinext/server/app-router-entry';
import application from './worker/index';

/**
 * The `ChatRoom` Durable Object class.
 *
 * `exports.durableObject({ storage: 'sqlite' })` in `cloudflare.config.ts` declares a namespace
 * backed by a class of exactly this name on this module. The re-export is what makes the class
 * reachable at that name after bundling; without it the namespace would have no implementation and
 * every join would fail at runtime rather than at build time.
 */
export { ChatRoom } from './worker/infrastructure/chat-room';

/**
 * The bindings Vinext's entrypoint declares an interest in.
 *
 * Its `fetch` is typed to accept only `{ ASSETS?: Fetcher }` — the one binding it uses — rather
 * than this Worker's full `Env`, and TypeScript rejects passing an object type with no declared
 * overlap. Restating the parameter shape here documents which binding the framework actually reads
 * and lets the full `Env` be forwarded without an `as unknown as` double cast.
 */
type AppRouterEnv = Parameters<typeof appRouter.fetch>[1];

/**
 * Whether a request is a WebSocket upgrade.
 *
 * The check is on the `Upgrade` header rather than on the path, and that is deliberate: it is the
 * protocol, not the route, that Vinext cannot carry (see {@link fetch}). Matching the header means a
 * plain `GET` to the socket path still travels the ordinary Vinext route and receives the API's
 * `426 Upgrade Required`, so the "wrong protocol" answer is produced by the same route table as
 * every other response rather than by this file.
 *
 * @param request Incoming request.
 * @returns `true` when the request asks to switch to the WebSocket protocol.
 */
function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

export default {
  /**
   * Serve a request, sending WebSocket upgrades to the API and everything else to Vinext.
   *
   * ## Why the upgrade cannot go through a route handler
   *
   * Every other endpoint in this demo is an ordinary `app/api/**\/route.ts` handler that forwards
   * into the same Hono application, which is how the family rules want it. The upgrade cannot be,
   * and the reason is a hard limitation rather than a preference: Vinext's route-handler pipeline
   * reconstructs the handler's response (`new Response(body, { status, headers })`) to apply
   * cache-control and cookie policy. Two things then fail, both at runtime:
   *
   * - `new Response()` rejects a `101` outright — _"Responses may only be constructed with status
   *   codes in the range 200 to 599"_ — because a protocol switch is not an ordinary response.
   * - Even if it were permitted, reconstruction drops the `webSocket` property, which is the only
   *   part of the response that matters; the pipeline also calls `response.clone()`, which throws
   *   _"Cannot clone a response to a WebSocket handshake."_
   *
   * So a `101` cannot survive the App Router pipeline in Vinext 1.0.0, and the upgrade has to reach
   * the API without passing through it. This is the narrowest possible exception: it is keyed on
   * the protocol, it changes no path, and every non-upgrade request — including a plain `GET` to
   * the socket route — is untouched and still routed by Vinext.
   *
   * Authentication is unaffected, which is the part worth being sure about. The request goes to
   * exactly the same Hono application, so the same `cloudflareAccess` middleware validates the same
   * JWT and the same audience before the upgrade reaches a room. Bypassing the _framework_ is not
   * bypassing the _API_.
   *
   * @param request Incoming request.
   * @param env Worker bindings, forwarded to the API application when it handles an upgrade.
   * @param ctx Execution context, passed to Vinext for every non-upgrade request.
   * @returns A `101 Switching Protocols` response carrying the client socket for an upgrade, or
   *   whatever Vinext renders for any other request.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (isWebSocketUpgrade(request)) {
      return application.fetch(request, env, ctx);
    }
    return appRouter.fetch(request, env satisfies object as AppRouterEnv, ctx);
  }
};
