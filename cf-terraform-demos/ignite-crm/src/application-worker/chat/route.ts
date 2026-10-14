/**
 * @file The chat module's HTTP surface, mounted under `/api/v1/chat`:
 *
 *   - `GET /session` tells the panel which session it may connect to. The identifier is derived from
 *     the verified identity (`./session.ts`), so the browser learns its own session name rather
 *     than choosing one.
 *   - `ALL /:sessionId` and `ALL /:sessionId/*` dispatch to the chat Durable Object. This is where
 *     the WebSocket upgrade, the Agents SDK's own `get-messages` request, and every protocol frame
 *     arrive. The wildcard is load-bearing rather than defensive: the agent serves its own
 *     subpaths, and matching only the bare session path left the panel's transcript request
 *     answering `404`. **The upgrade travels as a request, not as an RPC call** — a `WebSocket` is
 *     not serializable and the Hibernation API completes the protocol switch against the incoming
 *     request itself (root `AGENTS.md`). The object may trust the identity it is given because it
 *     has no route of its own: the only way to reach it is through this handler, which has already
 *     authenticated the caller through the same Access policy as every other `/api/*` route, and
 *     which passes the verified identity as Agents SDK props rather than as a header a client could
 *     spell.
 */

import { getAgentByName } from 'agents';
import { Hono, type MiddlewareHandler } from 'hono';
import { forbidden } from '@adrianhall/cloudflare-toolkit/errors';
import { ChatSessionSchema } from '../../shared/api/chat.ts';
import { actorOf, type ApiEnv } from '../api/context.ts';
import { checkResponse } from '../api/problems.ts';
import type { ChatAgentProps, CrmChatAgent } from './chat-agent.ts';
import { chatInstanceName, deriveChatSessionId } from './session.ts';

/**
 * Dispatch an authenticated request to the caller's own chat session object.
 *
 * Shared by the bare session path (the WebSocket upgrade) and its subpaths (the agent's own
 * `get-messages`), so both are gated by exactly the same ownership check rather than by two copies
 * of it.
 *
 * @returns Middleware that answers with the object's response — for an upgrade, a `101` carrying
 *   the socket.
 */
function dispatchToSession(): MiddlewareHandler<ApiEnv> {
  return async (context) => {
    const actor = await actorOf(context);
    const expected = await deriveChatSessionId(actor.userId);
    if (context.req.param('sessionId') !== expected) {
      // Non-enumerating by construction: every caller gets the same answer whether the name belongs
      // to nobody or to somebody else, so a probe learns nothing about other users' sessions.
      throw forbidden({ detail: 'That chat session does not belong to you.' });
    }
    const agent = await getAgentByName<Env, CrmChatAgent, ChatAgentProps>(
      context.env.CHAT_AGENT as DurableObjectNamespace<CrmChatAgent>,
      chatInstanceName(actor.userId, expected),
      { props: { email: actor.email, userId: actor.userId, requestId: actor.requestId } }
    );
    return agent.fetch(context.req.raw);
  };
}

/**
 * Build the chat router.
 *
 * @returns A Hono application to mount at `/api/v1/chat`.
 */
export function chatRoutes(): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get('/session', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(ChatSessionSchema, { sessionId: await deriveChatSessionId(actor.userId) })
    );
  });

  routes.all('/:sessionId/*', dispatchToSession());
  routes.all('/:sessionId', dispatchToSession());

  return routes;
}
