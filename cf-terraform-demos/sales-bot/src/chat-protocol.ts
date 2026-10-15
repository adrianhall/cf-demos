/**
 * @file The WebSocket wire protocol, shared verbatim by the Durable Object that produces the frames
 *   (`src/worker/infrastructure/conversation-session.ts`) and the browser store that consumes them
 *   (`src/client/stores.ts`). This module sits outside both `src/worker/` and `src/client/` because
 *   it belongs to neither: it is the contract between them. Keeping one definition means a frame
 *   the session can send is, by construction, a frame the client can handle — TypeScript fails the
 *   build otherwise. The sibling `src/access-policies.ts` plays the same role for authorization.
 *   The domain types re-used here come from the domain layer, so the wire format is a projection of
 *   the domain rather than a parallel model kept in step by hand.
 */

import type { ConversationTurn } from './worker/domain/conversation';

export type { ConversationTurn };

/**
 * WebSocket close code the session sends when it refuses a connection whose conversation the
 * verified caller does not own.
 *
 * It exists so the browser can tell "you may not watch this conversation" from a dropped
 * connection. Those look identical at the socket level but call for opposite responses: a drop
 * should reconnect, while retrying an unauthorized conversation would loop forever. `4003` sits in
 * the 4000–4999 range RFC 6455 reserves for application use.
 */
export const NOT_OWNER_CLOSE_CODE = 4_003;

/**
 * The bounded transcript the session replays as the first frame after a successful connection.
 *
 * Sent as a frame rather than fetched separately so the connection itself defines the starting
 * point: everything in this frame happened before the socket opened and everything after arrived
 * after. A separate fetch would leave a window in which a turn appears both in the fetched
 * transcript and in a later broadcast, or in neither.
 */
export interface TranscriptFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'transcript';
  /**
   * Recent turns in sequence order, oldest first.
   */
  turns: ConversationTurn[];
}

/**
 * One newly persisted turn, broadcast to every connection watching the conversation.
 *
 * Always sent _after_ the turn is durable in D1. A client that receives this frame is therefore
 * looking at something a later transcript replay will also contain.
 */
export interface TurnFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'turn';
  /**
   * The turn as persisted, including the sequence number the session assigned.
   */
  turn: ConversationTurn;
}

/**
 * Progress of the answer workflow for the question currently being handled.
 *
 * The workflow retrieves, decides, and only then generates, which on a slow model is several
 * seconds during which nothing would otherwise appear. Naming the stage rather than showing an
 * unlabelled spinner is also what lets the status be announced to assistive technology in words.
 */
export interface StatusFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'status';
  /**
   * Stage the workflow has reached.
   */
  stage: 'retrieving' | 'deciding' | 'generating' | 'escalating' | 'idle';
}

/**
 * A rejected or failed submission, sent only to the connection that caused it.
 *
 * Carries a user-safe `detail` and never the provider's own error text. A failure is reported
 * rather than closing the socket: one rejected question is not a reason to disconnect somebody
 * mid-conversation.
 */
export interface ErrorFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'error';
  /**
   * User-safe explanation, taken from the `detail` of the RFC 9457 problem the application raised,
   * so a rejection over the socket reads the same as the equivalent rejection over HTTP.
   */
  detail: string;
}

/**
 * Every frame the session may send. A discriminated union, so a `switch` on `type` in the client is
 * checked for exhaustiveness and adding a frame here fails the build until the client handles it.
 */
export type ServerFrame = TranscriptFrame | TurnFrame | StatusFrame | ErrorFrame;

/**
 * Ask a question in this conversation.
 *
 * It carries no author. The requester is pinned to the connection when it is accepted, so there is
 * nothing for a client to assert and no field for it to forge — see
 * `src/worker/infrastructure/conversation-session.ts`. The domain rejects a payload that adds one.
 */
export interface AskFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'ask';
  /**
   * Candidate question text, validated by the domain before it becomes a durable turn.
   */
  question: string;
  /**
   * Client-generated key that makes a retried submission produce one turn rather than two.
   */
  idempotencyKey: string;
}

/**
 * Abandon the answer currently being produced.
 *
 * Cancellation is a frame rather than simply closing the socket because the two mean different
 * things: closing is "I have gone", while this is "I am still here and no longer want that answer".
 * The question stays in the transcript — it was asked — and no answer turn is written for it.
 */
export interface CancelFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'cancel';
}

/**
 * Ask for this conversation to be handled by a product manager.
 *
 * An explicit request, distinct from the escalation the workflow opens on its own when evidence is
 * insufficient. Both produce the same escalation record; only the recorded reason differs, which is
 * what lets an operator tell "the product could not answer" from "the salesperson wanted a human".
 */
export interface EscalateFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'escalate';
}

/**
 * Every frame a browser may send.
 */
export type ClientFrame = AskFrame | CancelFrame | EscalateFrame;
