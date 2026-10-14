/**
 * @file Chat session naming. The Durable Object instance name is `${userId}:${sessionId}`, and
 *   **the browser never chooses either half**: the panel asks `GET /api/v1/chat/session` for the
 *   session it may connect to, and the route re-derives the same value from the verified Access
 *   identity before it dispatches. Without that, a user could connect to another user's session by
 *   guessing its name and read a transcript containing records they may not see
 *   (`specs/ignite-crm/05-ai-features.md` §3.2). The identifier is **derived from the user**, not
 *   random, because the product decision is "one live session per user" (§9.4): reopening the
 *   panel, reloading the page, or opening a second tab must rejoin the same live conversation, and
 *   a random identifier would need a server-side registry to do that. Expiry (§3.6) destroys the
 *   object's storage, so rejoining an expired session finds an **empty** transcript under the same
 *   name; the transcript is genuinely gone either way, which is the property the privacy posture
 *   rests on.
 */

/**
 * Namespace separating this derivation from any other use of a user identifier, so the value cannot
 * collide with an identifier generated elsewhere in the system.
 */
const SESSION_NAMESPACE = 'ignite-crm:chat-session:v1';

/**
 * Derive the chat session identifier for one installation user.
 *
 * The digest is shaped into a lowercase UUID — version `4`, RFC 9562 variant — so the value
 * satisfies the repository's `IdSchema` and looks like every other identifier the API returns. It
 * is deliberately _not_ a secret: it is only ever paired with the caller's own verified user id,
 * and the route re-derives it rather than trusting the path.
 *
 * @param userId Installation user identifier from the verified actor.
 * @returns The session identifier for that user; the same input always yields the same value.
 */
export async function deriveChatSessionId(userId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${SESSION_NAMESPACE}:${userId}`)
    )
  );
  const bytes = digest.slice(0, 16);
  // Pin the version and variant nibbles so the text form is a valid UUID rather than arbitrary hex.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

/**
 * Build the Durable Object instance name for a chat session.
 *
 * @param userId Installation user identifier from the verified actor.
 * @param sessionId Session identifier, already checked to be the caller's own.
 * @returns The instance name.
 */
export function chatInstanceName(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
