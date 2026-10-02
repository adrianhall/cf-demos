/**
 * @file Pure conversation state for the Chat panel. Plain functions over plain data: no Vue, no
 *   fetch, no DOM. The interesting rules — which turns get sent, how a streaming turn is grown, how
 *   history is bounded — are testable in isolation, and the composable above stays a thin reactive
 *   wrapper around them.
 */

import { MAX_MESSAGES, type ChatMessage } from '../../../shared/chat';

/**
 * One turn as the panel displays it.
 *
 * A superset of the wire {@link ChatMessage}: the panel also needs to know whether a turn is still
 * streaming, and which run produced it so Run Details can be shown beside it.
 */
export interface ConversationTurn {
  /**
   * Stable key for list rendering, so Vue does not reuse a DOM node between two different turns.
   */
  id: string;
  /**
   * Who produced the turn.
   */
  role: 'user' | 'assistant';
  /**
   * Text so far. An assistant turn grows as deltas arrive.
   */
  content: string;
  /**
   * Whether this turn is still being generated, so the panel can show a cursor and mark the region
   * as busy.
   */
  streaming: boolean;
  /**
   * Run that produced this assistant turn, absent for a user turn and for a turn whose run failed
   * before a receipt existed.
   */
  runId?: string;
}

/**
 * Turns the conversation into the message list the API accepts.
 *
 * Only completed turns are sent. A turn still streaming has no business being replayed as history,
 * and a failed turn's partial text would teach the model to continue something the visitor already
 * saw fail.
 *
 * The history is trimmed from the front when it exceeds the server's limit, keeping the most recent
 * turns: an older turn is the one a visitor is least likely to be referring to. Trimming
 * client-side keeps a long conversation working rather than failing validation once it grows past
 * the bound.
 *
 * @param turns Every turn currently displayed.
 * @returns The messages to send, oldest first, with at most {@link MAX_MESSAGES} entries.
 */
export function toRequestMessages(turns: readonly ConversationTurn[]): ChatMessage[] {
  const complete = turns
    .filter((turn) => !turn.streaming && turn.content.trim() !== '')
    .map((turn) => ({ role: turn.role, content: turn.content }));

  return complete.slice(-MAX_MESSAGES);
}

/**
 * Generates an opaque identifier for a run or a turn.
 *
 * `crypto.randomUUID` is available in every browser this demo supports and in the Workers runtime,
 * so there is no need for a counter that would collide across reloads. The value is opaque by
 * design: it appears in AI Gateway metadata, where it must correlate requests without describing
 * them.
 *
 * @returns A fresh UUID.
 */
export function newRunId(): string {
  return crypto.randomUUID();
}
