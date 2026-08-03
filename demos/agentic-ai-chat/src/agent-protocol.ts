/**
 * The one custom addition this demo makes on top of the Agents SDK's own chat wire protocol
 * (`cf_agent_use_chat_request`/`cf_agent_use_chat_response`/`cf_agent_chat_messages`, reverse-
 * engineered in Spike A's `REPORT.md` §5) -- shared by `ChatAgent`
 * (`src/worker/agent/chat-agent.ts`) and the browser's `useChatAgent` composable
 * (`src/client/composables/useChatAgent.ts`) so neither side can silently drift from the other
 * on this frame/close-code pair. Deliberately outside both `src/worker/` and `src/client/`,
 * exactly like `demos/chat`'s `src/chat-protocol.ts`, so either side can import it without
 * depending on the other's tree.
 */

/**
 * WebSocket close code `ChatAgent.destroy()` sends to every connected client just before
 * closing it (docs/06-AGENTIC-CHAT.md Phase 3, Section 11's "a chat is deleted while a turn is
 * in flight" failure mode), so the browser composable can distinguish a deliberate chat
 * removal from a transient drop and stop trying to reconnect into a chat that no longer
 * exists. Matches `demos/chat`'s `CHANNEL_REMOVED_CLOSE_CODE` convention: a private-use
 * WebSocket close code in the 4000-4999 range.
 */
export const CHAT_REMOVED_CLOSE_CODE = 4_001;

/**
 * Frame `ChatAgent.destroy()` sends to every connected client immediately before closing it
 * with {@link CHAT_REMOVED_CLOSE_CODE}. Belt-and-suspenders alongside the close code itself:
 * whichever of the two the client observes first is enough to treat the chat as removed.
 */
export interface ChatRemovedFrame {
  readonly type: "chat_removed";
}

/**
 * Frame `ChatAgent.afterTurnCompleted()` broadcasts once its own D1 writes (the recency touch,
 * and -- the first time only -- the generated title) have actually landed, so the sidebar can
 * refresh at the moment the data is genuinely ready rather than the moment the model's answer
 * stopped streaming.
 *
 * This distinction is load-bearing, not cosmetic: the AI SDK's `toUIMessageStreamResponse()`
 * enqueues the UI-message-stream's `{"type":"finish"}` part -- the signal
 * `useChatAgent.ts` uses to flip a turn from `"streaming"` to `"done"` -- as soon as the model
 * itself finishes generating, which is **before** `onFinish`'s own promise chain (this demo's
 * `afterTurnCompleted()`, including a second, non-streaming `env.AI` call for title generation)
 * resolves. Only the wire-level `done: true` flag on the *final* `cf_agent_use_chat_response`
 * frame is actually gated behind that chain finishing -- and no client-visible signal reacts to
 * that flag specifically (it exists only as `useChatAgent.ts`'s defensive fallback for a turn
 * with no explicit `finish` part). A client that reloaded its chat directory on the `"finish"`
 * part alone would reliably see the *previous* title/recency, not the one this same turn just
 * produced -- confirmed live by a diagnostic measuring both events' timestamps against a real
 * multi-chunk stream. Broadcasting this frame, instead of reacting to the turn's own streaming
 * status, is what closes that gap.
 */
export interface ChatMetadataUpdatedFrame {
  readonly type: "chat_metadata_updated";
}
