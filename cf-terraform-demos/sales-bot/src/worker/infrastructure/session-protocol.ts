/**
 * @file The internal contract between the Worker and a `ConversationSession` Durable Object for the
 *   one operation that cannot use RPC: the WebSocket upgrade. Every other call into a session is a
 *   typed RPC method — see `./durable-conversation-sessions.ts`. The upgrade cannot be, for two
 *   reasons that both point the same way. The response carries a live `WebSocket`, which is not
 *   serializable, so returning one from an RPC method fails at runtime with `DataCloneError: Could
 *   not serialize object of type "WebSocket"`. And the WebSocket Hibernation API completes the
 *   protocol switch against the incoming request itself, so the request has to reach the object
 *   rather than being reduced to arguments. The upgrade therefore travels over `fetch()`, and the
 *   requester's verified identity has to travel with it as a request header. A header-borne
 *   identity is only safe under a stated rule, so the rule lives here, in one place, next to the
 *   headers it governs.
 */

/**
 * Header carrying the verified requester's identity key on an upgrade request to a session.
 *
 * **The session trusts these headers unconditionally.** That is sound only because of two
 * properties, and both must hold:
 *
 * 1. A Durable Object has no route of its own. The only way to reach a session is through this Worker,
 *    which authenticates every request with Cloudflare Access and resolves the actor from D1 before
 *    it gets anywhere near one.
 * 2. {@link withVerifiedIdentity} deletes any inbound copy of every one of these headers before
 *    setting its own values. A client that sends `X-SalesBot-Identity` has it discarded, not
 *    honoured.
 *
 * The second point is the one somebody could forget, which is why the deletion and the assignment
 * are a single function that cannot be half-performed, and why the integration suite asserts that a
 * smuggled header — including a differently-cased spelling, since header names are case-insensitive
 * — is ignored.
 */
export const IDENTITY_HEADER = 'X-SalesBot-Identity';

/**
 * Header carrying the verified requester's email.
 *
 * Carried alongside the key because AI Gateway attribution and the structured logs want different
 * values: the key identifies the actor in metadata, and the email is what a person recognises. Both
 * come from the same verified source and are scrubbed together.
 */
export const EMAIL_HEADER = 'X-SalesBot-Email';

/**
 * Header carrying the requester's audience clearance, resolved from D1.
 *
 * This is the one that makes the scrubbing rule load-bearing rather than tidy. A client that could
 * set its own clearance could read NDA-only FAQs, so this header is exactly what an attacker would
 * try to smuggle — and it is deleted by the same single operation as the others.
 */
export const CLEARANCE_HEADER = 'X-SalesBot-Clearance';

/**
 * Header carrying the requester's role.
 */
export const ROLE_HEADER = 'X-SalesBot-Role';

/**
 * Header carrying the request's correlation identifier, so a socket's work can be tied back to the
 * HTTP request that opened it.
 */
export const CORRELATION_HEADER = 'X-SalesBot-Correlation';

/**
 * Every header the Worker sets on an upgrade and therefore must scrub first.
 *
 * One list rather than five constants used individually, because the risk is forgetting one: a
 * scrubbing routine that deletes four of five headers is worse than none at all, since it reads as
 * if the problem has been handled.
 */
export const VERIFIED_HEADERS = [
  IDENTITY_HEADER,
  EMAIL_HEADER,
  CLEARANCE_HEADER,
  ROLE_HEADER,
  CORRELATION_HEADER
] as const;

/**
 * The verified facts the Worker forwards to a session.
 *
 * Assembled only from the Access middleware's identity and the actor resolved from D1. No field on
 * it can originate from a request.
 */
export interface VerifiedSessionIdentity {
  /**
   * Stable identity key of the requester.
   */
  identityKey: string;
  /**
   * Verified email.
   */
  email: string;
  /**
   * Audience clearance resolved from D1.
   */
  clearance: string;
  /**
   * Role resolved from D1.
   */
  role: string;
  /**
   * Correlation identifier for the request that opened the socket.
   */
  correlationId: string;
}

/**
 * Rebuild an upgrade request carrying the verified identity and no client-supplied copy of it.
 *
 * Deleting before setting is the entire point. `Headers.delete` is case-insensitive, so a client
 * sending `x-salesbot-clearance` is covered by deleting `X-SalesBot-Clearance` — the test asserts
 * that explicitly rather than trusting the reading. Doing both in one function means the deletion
 * and the assignment cannot drift apart, and there is a single place to test.
 *
 * @param request The requester's own upgrade request, whose `Upgrade` header and connection state
 *   the Hibernation API needs in order to complete the protocol switch.
 * @param identity Verified facts to record on the request.
 * @returns A request identical to the original except that every header in {@link VERIFIED_HEADERS}
 *   holds a value this Worker verified, and nothing else.
 */
export function withVerifiedIdentity(request: Request, identity: VerifiedSessionIdentity): Request {
  const headers = new Headers(request.headers);
  for (const header of VERIFIED_HEADERS) {
    headers.delete(header);
  }
  headers.set(IDENTITY_HEADER, identity.identityKey);
  headers.set(EMAIL_HEADER, identity.email);
  headers.set(CLEARANCE_HEADER, identity.clearance);
  headers.set(ROLE_HEADER, identity.role);
  headers.set(CORRELATION_HEADER, identity.correlationId);
  return new Request(request, { headers });
}

/**
 * Read the verified identity back from an upgrade request inside the session.
 *
 * Returns `null` rather than throwing when a header is missing, so the session can refuse the
 * connection instead of accepting an unattributed one. That path is unreachable through the Worker,
 * which always sets all five; it exists so a direct call during development fails clearly rather
 * than creating a socket nobody owns.
 *
 * @param request Upgrade request forwarded by the Worker.
 * @returns The verified identity, or `null` when any header is absent or empty.
 */
export function readVerifiedIdentity(request: Request): VerifiedSessionIdentity | null {
  const identityKey = request.headers.get(IDENTITY_HEADER);
  const email = request.headers.get(EMAIL_HEADER);
  const clearance = request.headers.get(CLEARANCE_HEADER);
  const role = request.headers.get(ROLE_HEADER);
  const correlationId = request.headers.get(CORRELATION_HEADER);

  if (!identityKey || !email || !clearance || !role || !correlationId) {
    return null;
  }
  return { identityKey, email, clearance, role, correlationId };
}
