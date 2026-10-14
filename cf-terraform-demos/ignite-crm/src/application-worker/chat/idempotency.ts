/**
 * @file Idempotency keys for chat-driven mutations. The key is **derived**, not generated: an
 *   approval replayed after a reconnect — the same turn, the same tool call, sent twice — must
 *   produce the same key, so the Data Worker's idempotency record turns the second attempt into a
 *   replay of the first rather than a second record (`specs/ignite-crm/05-ai-features.md` §3.5). A
 *   fresh random key per execution would create two. The model never supplies a key. Its own value,
 *   if it invents one, is replaced before the call reaches the Data Worker, so a model cannot make
 *   two distinct writes collide or one write duplicate.
 */

/**
 * Placeholder substituted for the catalogue's required `idempotencyKey` while the model's arguments
 * are validated. It never reaches the Data Worker: {@link deriveIdempotencyKey}'s value replaces it
 * at execution. Exported so the test suite can assert that substitution.
 */
export const CHAT_IDEMPOTENCY_PLACEHOLDER = 'chat-pending-approval';

/**
 * Derive the idempotency key for one tool call in one chat turn.
 *
 * @param requestId Identifier of the chat request this turn belongs to.
 * @param toolCallId Identifier the model's tool call carries.
 * @returns A stable key for that exact tool call; identical inputs always give an identical key.
 */
export function deriveIdempotencyKey(requestId: string, toolCallId: string): string {
  return `chat:${requestId}:${toolCallId}`;
}
