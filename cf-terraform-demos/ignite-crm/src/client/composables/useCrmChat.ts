/**
 * @file The chat panel's conversation state: connect, load the transcript, send a turn, resolve an
 *   approval, and clear. `useAgentChat` from `@cloudflare/ai-chat/react` is React-only, so this
 *   composable is the Vue equivalent over the same wire protocol: `@ai-sdk/vue`'s `useChat` driving
 *   the Agents SDK's `WebSocketChatTransport`. The three things the React hook would have done for
 *   us are therefore ours, and each is tested:
 *
 *   1. **History loading** — the transcript lives in the Durable Object, so the panel fetches it on
 *      connect instead of starting empty.
 *   2. **Reconnect resume** — after connecting, one `resumeStream()` re-attaches to a turn that is
 *      still running, rather than leaving a half-rendered answer or starting a second turn.
 *   3. **Tool continuation** — after an approval decision, the server continues the paused turn on a
 *      new stream, which the transport only attaches to when told to expect it. It is imported only
 *      by the lazily loaded panel, so none of this is in the initial SPA download.
 */

import { WebSocketChatTransport } from 'agents/chat/transport';
import type { ChatStatus, UIMessage } from 'ai';
import { onScopeDispose, ref, shallowRef, type Ref, watch } from 'vue';
import { useChat } from '@ai-sdk/vue';
import type { ChatPageContext } from '../../shared/api/chat.ts';
import { api, type ApiClient } from '../services/api-client.ts';
import {
  type ChatConnection,
  createChatConnection,
  loadChatHistory
} from '../services/chat-connection.ts';
import { presentChatFailure } from '../services/chat-errors.ts';

/**
 * Key under which the browser remembers that this tab has had a conversation, so an empty
 * transcript can be told apart from an expired one. Session storage, not local storage: the fact is
 * about this tab's visit, and nothing about a conversation should outlive the browser session.
 */
const HAD_CONVERSATION_KEY = 'ignite-crm.chat.had-conversation';
const CHAT_DEBUG = '[ignite-chat-debug]';

/**
 * Write a temporary, content-free chat diagnostic.
 *
 * @param event Lifecycle event.
 * @param details Safe metadata only.
 * @returns Nothing.
 */
function debugChat(event: string, details: Record<string, unknown> = {}): void {
  console.info(`${CHAT_DEBUG} ${event} ${JSON.stringify(details)}`);
}

/**
 * How the panel is getting on with its session.
 */
export type ChatConnectionState = 'connecting' | 'ready' | 'error';

/**
 * Options for {@link useCrmChat}.
 */
export interface UseCrmChatOptions {
  /**
   * API client, injectable for tests.
   */
  readonly client?: ApiClient;
  /**
   * Open a socket to a session; injectable for tests, which have no WebSocket server.
   */
  readonly connect?: (sessionId: string) => ChatConnection;
  /**
   * Load a session's stored transcript; injectable for tests.
   */
  readonly loadHistory?: (sessionId: string, signal?: AbortSignal) => Promise<UIMessage[]>;
  /**
   * The record the user is looking at, read when a message is sent so the hint always describes the
   * page they were on at that moment.
   */
  readonly pageContext?: () => ChatPageContext | undefined;
}

/**
 * What {@link useCrmChat} returns.
 */
export interface UseCrmChat {
  /**
   * The transcript, oldest first.
   */
  readonly messages: Ref<UIMessage[]>;
  /**
   * The AI SDK's turn status.
   */
  readonly status: Ref<ChatStatus>;
  /**
   * Connection state of the session itself, which is separate from a turn's status: the socket can
   * be fine while no turn is running, and a turn cannot start while it is not.
   */
  readonly connection: Ref<ChatConnectionState>;
  /**
   * A message explaining a failure, safe to display.
   */
  readonly error: Ref<string | null>;
  /**
   * Whether the session the panel rejoined had expired, so the panel can say so once.
   */
  readonly expired: Ref<boolean>;
  /**
   * Send one user message.
   *
   * @param text The user's message; blank input is ignored.
   * @returns Once the turn has been submitted.
   */
  send(text: string): Promise<void>;
  /**
   * Approve or decline a pending write.
   *
   * @param approvalId Approval identifier from the tool part.
   * @param toolCallId Tool call the approval belongs to.
   * @param approved Whether the user approved it.
   * @returns Once the decision has been sent and the paused turn resumed.
   */
  decide(approvalId: string, toolCallId: string, approved: boolean): Promise<void>;
  /**
   * Discard the conversation, on the server as well as on screen.
   *
   * @returns Once the transcript has been cleared.
   */
  clear(): Promise<void>;
  /**
   * Stop the turn in progress, keeping what has already been generated.
   *
   * @returns Once the turn has stopped.
   */
  stop(): Promise<void>;
}

/**
 * Drive one chat session for the lifetime of the calling component.
 *
 * The socket is opened when this is called and closed when the component's scope is disposed, so
 * closing the panel really does disconnect rather than leaving a socket open behind it.
 *
 * @param options Injection points for tests and the page-context accessor.
 * @returns The conversation state and its actions.
 */
export function useCrmChat(options: UseCrmChatOptions = {}): UseCrmChat {
  const client = options.client ?? api;
  const connect = options.connect ?? createChatConnection;
  const loadHistory = options.loadHistory ?? loadChatHistory;

  const connection = ref<ChatConnectionState>('connecting');
  const error = shallowRef<string | null>(null);
  const expired = shallowRef(false);
  const abort = new AbortController();
  let socket: ChatConnection | null = null;

  // A transport is needed before the socket exists, because `useChat` is created synchronously.
  // `setAgent` points it at the real connection once that is open; until then its sends are no-ops,
  // which is exactly right — no turn can start before the session is ready.
  const transport = new WebSocketChatTransport({
    agent: {
      send: () => false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  });

  const chat = useChat({
    transport,
    onError: (caught) => {
      debugChat('sdk-on-error', {
        name: caught instanceof Error ? caught.name : typeof caught,
        message: caught instanceof Error ? caught.message : undefined
      });
      // Do not retry here. A retry can replay an approved mutation or its continuation; recovery is
      // intentionally a fresh, explicit user action after the Gateway window has reset.
      error.value = presentChatFailure(caught).message;
    }
  });

  // The AI SDK exposes the stream failure separately from its callback. Keep a watcher as a second
  // boundary because WebSocket/AI-SDK versions can update `error` without invoking the callback for
  // every terminal frame. This is what turns a provider 402 into a visible panel alert instead of a
  // silent stopped stream.
  watch(
    chat.error,
    (caught) => {
      debugChat('sdk-error-watch', {
        present: caught !== undefined,
        name: caught?.name,
        message: caught?.message
      });
      if (caught !== undefined) {
        error.value = presentChatFailure(caught).message;
      }
    },
    { immediate: true }
  );

  watch(chat.status, (status, previous) => {
    debugChat('sdk-status-watch', { status, previous, hasError: chat.error.value !== undefined });
    if (status === 'error' && error.value === null) {
      // Some AI SDK/Agents transport versions only transition the chat status and do not expose the
      // terminal stream error through either `onError` or `chat.error`. Do not leave the user with an
      // indefinite spinner in that case; the provider details are unavailable, so use the safe
      // generic message.
      error.value = presentChatFailure(new Error('Chat stream failed.')).message;
    }
  });

  /**
   * Resolve the session, load its transcript, and attach the socket.
   *
   * @returns Once the panel is ready or has failed.
   */
  async function start(): Promise<void> {
    debugChat('session-start');
    try {
      const session = await client.chatSession(abort.signal);
      debugChat('session-ready');
      const history = await loadHistory(session.sessionId, abort.signal);
      if (abort.signal.aborted) {
        return;
      }
      chat.messages.value = history;
      expired.value = history.length === 0 && hadConversation();
      if (history.length > 0) {
        rememberConversation();
      }
      socket = connect(session.sessionId);
      transport.setAgent(socket);
      connection.value = 'ready';
      debugChat('connection-ready');
      // Re-attach to a turn that is still running after a reload or a dropped connection. There is
      // usually nothing to resume, and the transport answers that case with a null stream.
      await chat.resumeStream().catch(() => undefined);
    } catch (caught) {
      debugChat('session-failed', {
        name: caught instanceof Error ? caught.name : typeof caught,
        message: caught instanceof Error ? caught.message : undefined,
        aborted: abort.signal.aborted
      });
      if (abort.signal.aborted) {
        return;
      }
      connection.value = 'error';
      error.value = presentChatFailure(caught).message;
    }
  }

  void start();

  onScopeDispose(() => {
    abort.abort();
    socket?.close();
    socket = null;
  });

  return {
    messages: chat.messages,
    status: chat.status,
    connection,
    error,
    expired,
    send: async (text) => {
      const body = text.trim();
      if (body === '' || connection.value !== 'ready') {
        return;
      }
      // A new explicit turn is the only supported recovery after a failed model request. Clear the
      // previous alert here rather than retrying automatically; an automatic retry could replay an
      // approval continuation or duplicate a mutation.
      error.value = null;
      expired.value = false;
      rememberConversation();
      const context = options.pageContext?.();
      debugChat('send-start', { status: chat.status.value, connection: connection.value });
      await chat.sendMessage(
        { text: body },
        context === undefined ? {} : { body: { pageContext: context } }
      );
      debugChat('send-settled', {
        status: chat.status.value,
        hasError: chat.error.value !== undefined
      });
    },
    decide: async (approvalId, toolCallId, approved) => {
      // Two messages, on purpose. The SDK's own state has to record the decision so the approval
      // card stops asking; the server has to be told so the paused turn continues. Neither one
      // implies the other, so a client that sent only one would either show a stuck card or never
      // execute the approved write.
      await chat.addToolApprovalResponse({ id: approvalId, approved });
      socket?.send(
        JSON.stringify({ type: 'cf_agent_tool_approval', toolCallId, approved, autoContinue: true })
      );
      transport.expectToolContinuation();
      await chat.resumeStream().catch(() => undefined);
    },
    clear: async () => {
      socket?.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
      chat.messages.value = [];
      expired.value = false;
      forgetConversation();
      await Promise.resolve();
    },
    stop: () => chat.stop()
  };
}

/**
 * Whether this tab has had a conversation in this browser session.
 *
 * @returns `true` when a conversation was started earlier in this session.
 */
function hadConversation(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(HAD_CONVERSATION_KEY) === 'yes';
  } catch {
    // Storage can be unavailable (a privacy mode, a sandboxed frame). The expiry notice is a
    // courtesy, so losing it is acceptable; failing the panel for it would not be.
    return false;
  }
}

/**
 * Record that a conversation exists, so a later empty transcript reads as an expiry.
 *
 * @returns Nothing.
 */
function rememberConversation(): void {
  try {
    globalThis.sessionStorage?.setItem(HAD_CONVERSATION_KEY, 'yes');
  } catch {
    // See hadConversation().
  }
}

/**
 * Forget the conversation, so clearing it deliberately is not later reported as an expiry.
 *
 * @returns Nothing.
 */
function forgetConversation(): void {
  try {
    globalThis.sessionStorage?.removeItem(HAD_CONVERSATION_KEY);
  } catch {
    // See hadConversation().
  }
}
