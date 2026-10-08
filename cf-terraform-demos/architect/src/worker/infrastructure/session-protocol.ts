/**
 * @file The internal contract between the Worker and a `DiagramSession` Durable Object for the one
 *   operation that cannot use RPC: the WebSocket upgrade. Every other call into a session is a
 *   typed RPC method — see `./durable-diagram-sessions.ts`. The upgrade cannot be, for two
 *   independent reasons that both point the same way. The response carries a live `WebSocket`,
 *   which is not serializable, so returning one from an RPC method fails at runtime with
 *   `DataCloneError: Could not serialize object of type "WebSocket"`. And the Hibernation API
 *   completes the protocol switch against the incoming request itself, so the request has to reach
 *   the object rather than being reduced to arguments. The upgrade therefore travels over
 *   `fetch()`, and the viewer's verified identity has to travel with it as a request header. A
 *   header-borne identity is only safe under a stated rule, so the rule lives here, in one place,
 *   next to the header it governs.
 */

/**
 * Header carrying the verified Cloudflare Access identity on an upgrade request to a session.
 *
 * **The session trusts this header unconditionally.** That is sound only because of two properties,
 * and both must hold:
 *
 * 1. A Durable Object has no route of its own. The only way to reach a session is through this Worker,
 *    which authenticates every request — `/api/*` is an authenticating, non-redirecting entry in
 *    `src/access-policies.ts` — and then checks diagram ownership before forwarding.
 * 2. {@link withVerifiedIdentity} deletes any inbound copy of this header before setting its own
 *    value. A client that sends `X-Architect-Identity` has it discarded, not honoured.
 *
 * The second point is the one that needs care, because it is a rule somebody could forget.
 * {@link withVerifiedIdentity} exists so the deletion and the assignment are a single operation
 * that cannot be half-performed, and both the unit suite and the Workers-runtime suite assert that
 * a smuggled header — including a differently-cased spelling, since header names are
 * case-insensitive — is ignored.
 */
export const IDENTITY_HEADER = 'X-Architect-Identity';

/**
 * Rebuilds an upgrade request carrying the verified identity and no client-supplied copy of it.
 *
 * Deleting before setting is the whole point, and the order matters: `Headers.set` already replaces
 * a single-valued header, but deleting first makes the intent explicit at the one place it is
 * expressed, and stays correct even if this ever became a header a client could send more than
 * once. Both operations are in this one function so neither can happen without the other.
 *
 * @param request The viewer's own upgrade request, whose `Upgrade` header and connection state the
 *   Hibernation API needs in order to complete the protocol switch.
 * @param viewer Verified Cloudflare Access identity to record on the request.
 * @returns A request identical to the original except that {@link IDENTITY_HEADER} holds the
 *   verified identity and nothing else. The original request is not modified.
 */
export function withVerifiedIdentity(request: Request, viewer: string): Request {
  const headers = new Headers(request.headers);
  headers.delete(IDENTITY_HEADER);
  headers.set(IDENTITY_HEADER, viewer);
  return new Request(request, { headers });
}
