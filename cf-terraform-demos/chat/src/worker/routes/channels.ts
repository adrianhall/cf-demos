import { Hono } from 'hono';
import {
  currentIdentityEmail,
  jsonBodyLimit,
  readJsonBody,
  upgradeRequired
} from '@demos/worker-common';
import type { AppBindings } from '../bindings';

/**
 * Channel API, mounted at `/api/channels`.
 *
 * Every route is behind Cloudflare Access (see `../middleware/access.ts`). Unlike the sibling
 * `todo` demo, no route is scoped to the caller's identity: this is a shared workspace, so every
 * authenticated participant sees and may change the same directory. The identity is used to record
 * who created a channel and to pin authorship on a connection, never to filter what a participant
 * is allowed to see.
 *
 * Handlers here are thin by design — they read the verified identity, hand untrusted input to
 * `ChatService`, and shape the response. Validation, ordering, and the choice of which store backs
 * which concern all live in the application and domain tiers.
 */
export const channelsRouter = new Hono<AppBindings>();

/**
 * List every channel in the workspace.
 *
 * @param context Hono request context providing the chat service.
 * @returns A JSON `200` response containing every channel, name-ordered.
 * @throws {Error} When the directory cannot be read.
 */
channelsRouter.get('/', async (context) =>
  context.json({ channels: await context.get('CHAT_SERVICE').listChannels() })
);

/**
 * Create a channel from `{ "name": "..." }`.
 *
 * The body limit is applied to this route specifically rather than to the whole router, because it
 * is the only route here that has a body — and applying it to the upgrade route below would
 * interpose a body reader on a request that must be passed through untouched.
 *
 * @param context Hono request context containing the bounded JSON body and chat service.
 * @returns A JSON `201` response containing the newly created channel.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} When the body is not valid JSON (`400`), the name is missing or
 *   malformed (`422`), or a channel with that name already exists (`409`).
 * @throws {Error} When the directory cannot be written.
 */
channelsRouter.post('/', jsonBodyLimit(), async (context) => {
  const channel = await context
    .get('CHAT_SERVICE')
    .createChannel(await readJsonBody(context.req.raw), currentIdentityEmail(context));
  // The channel name is shared, non-personal data, so it is safe to log; the creator's identity
  // is not, and is deliberately omitted.
  context.get('LOGGER').info('channel_created', { channel: channel.name });
  return context.json({ channel }, 201);
});

/**
 * Remove a channel and everything said in it.
 *
 * Any authenticated participant may remove any channel. That is a real decision rather than an
 * oversight: this demo has no administrator role, and adding one would make the removal path about
 * authorization instead of about the two-store teardown ordering it exists to show. A product would
 * gate this — most simply by checking `createdBy`, as the sibling `link` demo gates its
 * administrative surface.
 *
 * @param context Hono request context containing the `channel` path parameter and chat service.
 * @returns An empty `204` response once the conversation is erased and the channel is delisted.
 * @throws {ProblemDetailsError} `notFound()` (404) when the name is malformed or no such channel
 *   exists.
 * @throws {Error} When the room cannot be destroyed or the directory cannot be written.
 */
channelsRouter.delete('/:channel', async (context) => {
  const channel = context.req.param('channel');
  await context.get('CHAT_SERVICE').removeChannel(channel);
  context.get('LOGGER').info('channel_removed', { channel });
  return new Response(null, { status: 204 });
});

/**
 * Open a participant's WebSocket connection to a channel.
 *
 * The `Upgrade` header is checked here, in the transport tier, because it is a fact about the HTTP
 * request rather than a business rule — `ChatService` should not have to know what protocol its
 * caller arrived over. A plain `GET` to this path is answered `426 Upgrade Required`, which says
 * precisely what is wrong, rather than the `400` a generic rejection would give.
 *
 * The response returned by the service carries the client end of the socket and a `101` status. It
 * is returned verbatim: rebuilding it would drop the `webSocket` property, which is the one part of
 * the response that matters.
 *
 * @param context Hono request context containing the `channel` path parameter and chat service.
 * @returns A `101 Switching Protocols` response handing the socket to the browser.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `426` when the request is not a WebSocket upgrade; `notFound()`
 *   (404) when the channel name is malformed or no such channel exists.
 * @throws {Error} When the room cannot accept the connection.
 */
channelsRouter.get('/:channel/socket', async (context) => {
  if (context.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw upgradeRequired('This endpoint accepts WebSocket connections only.');
  }

  const channel = context.req.param('channel');
  const response = await context
    .get('CHAT_SERVICE')
    .joinChannel(channel, context.req.raw, currentIdentityEmail(context));
  context.get('LOGGER').info('channel_joined', { channel });
  return response;
});
