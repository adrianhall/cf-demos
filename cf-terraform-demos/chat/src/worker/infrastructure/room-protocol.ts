/**
 * @file The internal contract between the Worker and a `ChatRoom` Durable Object for the one
 *   operation that cannot use RPC: the WebSocket upgrade. Every other call into a room is a typed
 *   RPC method — see `./durable-chat-rooms.ts`. The upgrade cannot be, for two reasons that both
 *   point the same way. The response carries a live `WebSocket`, which is not serializable, so
 *   returning one from an RPC method fails at runtime with `DataCloneError: Could not serialize
 *   object of type "WebSocket"`. And the Hibernation API completes the protocol switch against the
 *   incoming request itself, so the request has to reach the object rather than being reduced to
 *   arguments. The upgrade therefore travels over `fetch()`, and the participant's verified
 *   identity has to travel with it as a request header. A header-borne identity is only safe under
 *   a stated rule, so the rule lives here, in one place, next to the header it governs.
 */

/**
 * Header carrying the verified Cloudflare Access identity on an upgrade request to a room.
 *
 * **The room trusts this header unconditionally.** That is sound only because of two properties,
 * and both must hold:
 *
 * 1. A Durable Object has no route of its own. The only way to reach a room is through this Worker,
 *    which authenticates every request before it gets anywhere near one.
 * 2. `DurableChatRooms.join` deletes any inbound copy of this header before setting its own value —
 *    see {@link withVerifiedIdentity}. A client that sends `X-Chat-Identity` has it discarded, not
 *    honoured.
 *
 * The second point is the one that needs care, because it is a rule somebody could forget.
 * {@link withVerifiedIdentity} exists so the deletion and the assignment are a single operation
 * that cannot be half-performed, and the integration suite asserts a smuggled header is ignored.
 */
export const IDENTITY_HEADER = 'X-Chat-Identity';

/**
 * Rebuild an upgrade request carrying the verified identity and no client-supplied copy of it.
 *
 * Deleting before setting is the whole point, and the order matters: `Headers.set` replaces a
 * single-valued header, but deleting first makes the intent explicit and is robust even if this
 * header ever became one a client could send more than once.
 *
 * @param request The participant's own upgrade request, whose `Upgrade` header and connection state
 *   the Hibernation API needs in order to complete the protocol switch.
 * @param participant Verified Cloudflare Access identity to record on the request.
 * @returns A request identical to the original except that {@link IDENTITY_HEADER} holds the
 *   verified identity and nothing else.
 */
export function withVerifiedIdentity(request: Request, participant: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(IDENTITY_HEADER);
  headers.set(IDENTITY_HEADER, participant);
  return new Request(request, { headers });
}
