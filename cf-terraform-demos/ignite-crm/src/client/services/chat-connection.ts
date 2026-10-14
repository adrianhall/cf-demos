/**
 * @file The panel's transport to its chat session: the Agents SDK WebSocket client and the
 *   transcript it loads on connect. This module is reached only from the lazily loaded chat panel,
 *   so the Agents client and the AI SDK's chat pieces stay out of the SPA's initial download (see
 *   `components/chat/ChatPanel.vue`).
 *
 *   ## Why a WebSocket and not `fetch`
 *
 *   A chat turn streams for several seconds and may pause mid-answer waiting for an approval, and a
 *   browser that reconnects must be able to re-attach to the turn already running rather than start
 *   a new one. That is what the Agents protocol provides, and `WebSocketChatTransport` is the AI
 *   SDK transport that speaks it.
 *
 *   ## Why the session name is not ours to choose
 *
 *   The path comes from `GET /api/v1/chat/session`, which derives it from the verified identity.
 *   The Worker re-derives and re-checks it on every connection, so a browser that invented a name
 *   is refused rather than connected to somebody else's transcript.
 */

import type { AgentConnection } from 'agents/chat/transport';
import { AgentClient } from 'agents/client';
import type { UIMessage } from 'ai';

/**
 * The Durable Object class the panel talks to. The Worker routes by path, so this only names the
 * class for the SDK's own bookkeeping.
 */
const AGENT_CLASS = 'CrmChatAgent';

/**
 * Stable diagnostic prefix for the temporary chat investigation. Messages intentionally contain
 * lifecycle metadata only — never prompts, transcript text, tokens, or tool arguments.
 */
const CHAT_DEBUG = '[ignite-chat-debug]';

/**
 * Write a bounded chat diagnostic message.
 *
 * @param event Lifecycle event name.
 * @param details Safe metadata about the event.
 * @returns Nothing.
 */
function debugChat(event: string, details: Record<string, unknown> = {}): void {
  console.info(`${CHAT_DEBUG} ${event} ${JSON.stringify(details)}`);
}

/**
 * Path prefix of the chat route, without a leading slash (PartySocket rejects one).
 *
 * @param sessionId Session identifier from `GET /api/v1/chat/session`.
 * @returns The base path for that session.
 */
function basePathFor(sessionId: string): string {
  return `api/v1/chat/${sessionId}`;
}

/**
 * A live connection to one chat session.
 */
export interface ChatConnection extends AgentConnection {
  /**
   * Close the socket and stop reconnecting.
   *
   * @returns Nothing.
   */
  close(): void;
}

/**
 * Open a connection to the signed-in user's chat session.
 *
 * @param sessionId Session identifier from `GET /api/v1/chat/session`.
 * @returns The connection; it reconnects on its own until {@link ChatConnection.close} is called.
 */
export function createChatConnection(sessionId: string): ChatConnection {
  debugChat('connection-create', {
    agent: AGENT_CLASS,
    basePath: basePathFor(sessionId),
    host: window.location.host
  });
  const client = new AgentClient({
    agent: AGENT_CLASS,
    basePath: basePathFor(sessionId),
    // The panel is served by the Worker it connects to, so the socket is always same-origin. Saying
    // so explicitly keeps the Access cookie in scope and keeps the connection inside the one origin
    // the Access policies cover.
    host: window.location.host
  });
  const originalSend = client.send.bind(client);
  client.send = ((data: unknown) => {
    let frame: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (typeof parsed === 'object' && parsed !== null) {
        frame = parsed as Record<string, unknown>;
      }
    } catch {
      // The transport may send a non-JSON control frame; log only that fact.
    }
    debugChat('socket-send', {
      type: typeof frame.type === 'string' ? frame.type : 'non-json',
      id: typeof frame.id === 'string' ? frame.id : undefined,
      bodyPresent: typeof frame.init === 'object' && frame.init !== null
    });
    return originalSend(data as never);
  }) as typeof client.send;
  client.addEventListener('open', () => debugChat('socket-open'));
  client.addEventListener('close', (event) =>
    debugChat('socket-close', { code: event.code, reason: event.reason, clean: event.wasClean })
  );
  client.addEventListener('error', () => debugChat('socket-error'));
  client.addEventListener('message', (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as {
        type?: unknown;
        id?: unknown;
        error?: unknown;
        done?: unknown;
        outcome?: unknown;
        body?: unknown;
      };
      debugChat('socket-frame', {
        type: typeof frame.type === 'string' ? frame.type : undefined,
        id: typeof frame.id === 'string' ? frame.id : undefined,
        error: frame.error === true,
        done: frame.done === true,
        outcome: typeof frame.outcome === 'string' ? frame.outcome : undefined,
        bodyPresent: typeof frame.body === 'string' && frame.body.length > 0
      });
    } catch {
      debugChat('socket-frame-invalid');
    }
  });
  debugChat('connection-created');
  return client;
}

/**
 * Load the session's persisted transcript.
 *
 * The agent answers this itself (`AIChatAgent` serves `get-messages` on its own route), so the
 * response is the SDK's `UIMessage` shape rather than one of the application's Valibot DTOs. It is
 * treated as untrusted anyway: anything that is not an array of objects with a role becomes an
 * empty transcript, so a malformed answer renders nothing instead of breaking the panel.
 *
 * @param sessionId Session identifier from `GET /api/v1/chat/session`.
 * @param signal Cancellation, so a panel closed mid-load does not apply its result.
 * @returns The stored messages, or an empty list when there are none.
 * @throws {Error} When the request fails or the session cannot be read; the panel reports this as a
 *   connection problem with a retry.
 */
export async function loadChatHistory(
  sessionId: string,
  signal?: AbortSignal
): Promise<UIMessage[]> {
  debugChat('history-request', { path: `/${basePathFor(sessionId)}/get-messages` });
  const response = await fetch(`/${basePathFor(sessionId)}/get-messages`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    ...(signal === undefined ? {} : { signal })
  });
  debugChat('history-response', {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get('content-type')
  });
  if (!response.ok) {
    throw new Error(`The conversation could not be loaded (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    return [];
  }
  return body.filter(
    (message): message is UIMessage =>
      typeof message === 'object' && message !== null && 'role' in message
  );
}
