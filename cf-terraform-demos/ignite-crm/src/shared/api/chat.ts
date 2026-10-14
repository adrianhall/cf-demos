/**
 * @file Wire schemas for the AI chat surface: the session handshake the panel performs before it
 *   opens a socket, and the optional page context it sends with a turn. The transcript itself is
 *   **not** described here. It never crosses this API as a resource: it lives in the chat session's
 *   Durable Object and travels over the Agents SDK's own WebSocket protocol, which the panel speaks
 *   through `@ai-sdk/vue`. What the browser needs from the REST surface is only the name of the
 *   session it may connect to.
 */

import * as v from 'valibot';
import { IdSchema } from '../common/ids.ts';

/**
 * `GET /api/v1/chat/session` response: the session the signed-in user may connect to.
 */
export const ChatSessionSchema = v.strictObject({
  /**
   * Server-derived session identifier. The browser never chooses it, because the Durable Object's
   * instance name is `${userId}:${sessionId}` and a client-chosen name is a client-chosen
   * transcript.
   */
  sessionId: IdSchema
});

/**
 * `GET /api/v1/chat/session` response body.
 */
export type ChatSession = v.InferOutput<typeof ChatSessionSchema>;

/**
 * Record kinds the panel may name as the page the user is looking at. Each maps to a read tool the
 * assistant already has, so a hint can only ever lead to an ordinarily authorised tool call.
 */
export const CHAT_CONTEXT_ROUTES = ['contact', 'company', 'deal', 'project', 'note'] as const;

/**
 * A record kind the panel may send as page context.
 */
export type ChatContextRoute = (typeof CHAT_CONTEXT_ROUTES)[number];

/**
 * Optional "the user is looking at this record" hint sent with a chat turn, so "summarise this
 * customer" works without the user pasting an identifier.
 *
 * It is a **hint only**: it is injected into the prompt as a sentence, never into a tool call, and
 * the tool call it leads to is authorised exactly as any other. A strict object keeps a client from
 * smuggling anything else into the prompt.
 */
export const ChatPageContextSchema = v.strictObject({
  /**
   * Kind of record on screen.
   */
  route: v.picklist(CHAT_CONTEXT_ROUTES),
  /**
   * Identifier of the record on screen.
   */
  id: IdSchema
});

/**
 * A page-context hint.
 */
export type ChatPageContext = v.InferOutput<typeof ChatPageContextSchema>;
