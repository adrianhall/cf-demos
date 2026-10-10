import { AgentClient } from "agents/client";
import {
  type ComputedRef,
  computed,
  type MaybeRefOrGetter,
  onScopeDispose,
  type ShallowRef,
  shallowRef,
  toValue,
  watch,
} from "vue";
import { CHAT_REMOVED_CLOSE_CODE } from "../../agent-protocol";
import {
  UiMessageStreamDecoder,
  type UiStreamPart,
} from "../lib/ui-message-stream";

/** Who authored one turn of the conversation. */
export type ChatTurnRole = "user" | "assistant";

/** Lifecycle of one turn as held in the browser tab. */
export type ChatTurnStatus = "streaming" | "done" | "error";

/** One file the `writeMarkdown` tool successfully attached to a turn (docs/06-AGENTIC-CHAT.md
 * Phase 9, US-8) -- enough for the transcript to render a download link
 * (`../../worker/routes/chats.ts`'s `GET /:id/files/:fileId`), never the file's own content. */
export interface ChatFileAttachment {
  /** Server-generated file id, path-segment of the download route. */
  readonly fileId: string;
  /** The sanitized filename to display and to hint the browser's own save-as dialog with. */
  readonly filename: string;
}

/** One turn of the conversation, as rendered by the transcript. */
export interface ChatTurn {
  /** Stable identifier for the life of this turn (the persisted message id once loaded from
   * history, or a freshly generated one for a turn submitted this session). */
  readonly id: string;
  /** Who authored this turn. */
  readonly role: ChatTurnRole;
  /** Accumulated text content. Grows incrementally for a `"streaming"` assistant turn. */
  readonly content: string;
  /** Current lifecycle state. */
  readonly status: ChatTurnStatus;
  /** Problem detail for a turn that ended in `"error"`, otherwise `null`. */
  readonly errorDetail: string | null;
  /** Files the `writeMarkdown` tool successfully attached to this turn (Phase 9, US-8), in the
   * order the tool produced them. Always empty for a user turn, and for an assistant turn that
   * never called the tool. */
  readonly attachments: readonly ChatFileAttachment[];
  /** Names of every skill the `activate_skill` tool activated for this turn (Phase 11, US-10),
   * in activation order, deduplicated -- the transcript's own "a skill was activated" indicator.
   * Always empty for a user turn, and for an assistant turn that matched no skill. */
  readonly activatedSkills: readonly string[];
}

/** A chat's running cost/token totals (docs/06-AGENTIC-CHAT.md Section 6.6a) -- mirrors
 * `src/worker/usage/types.ts`'s `ChatUsageSummary` (duplicated here, not imported, matching
 * `../stores/chats.ts`'s existing convention of defining its own client-side shape rather than
 * importing the Worker's). This is `ChatAgent.State`'s own shape, synced automatically to every
 * connected client -- never fetched separately. */
export interface ChatUsageSummary {
  /** Sum of every completed turn's cost, regardless of whether it is still an estimate. */
  readonly totalCostUsd: number;
  /** Sum of every completed turn's prompt (input) tokens. */
  readonly totalPromptTokens: number;
  /** Sum of every completed turn's completion (output) tokens. */
  readonly totalCompletionTokens: number;
  /** Total number of completed turns contributing to this total. */
  readonly turnCount: number;
  /** How many of those turns' figures are AI-Gateway-confirmed rather than estimated. */
  readonly confirmedTurnCount: number;
  /** The most recent contributing turn's timestamp, or `null` before any turn completes. */
  readonly lastUpdatedAt: string | null;
}

/** A {@link ChatUsageSummary} with every figure zeroed -- the value this composable exposes
 * before a chat's first `cf_agent_state` frame ever arrives. */
export function emptyUsageSummary(): ChatUsageSummary {
  return {
    totalCostUsd: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    turnCount: 0,
    confirmedTurnCount: 0,
    lastUpdatedAt: null,
  };
}

/**
 * One reconciliation transition event (docs/06-AGENTIC-CHAT.md Section 6.6a) -- mirrors
 * `../../agent-protocol.ts`'s `UsageReconciledFrame`/`UsageReconcileExhaustedFrame`, plus a
 * `receivedAt` timestamp so a watcher can distinguish two structurally-identical events (for
 * example two different turns both eventually exhausting) as genuinely separate occurrences to
 * animate, rather than a no-op re-render of an unchanged value.
 */
export interface UsageReconciliationEvent {
  /** Which transition occurred -- a successful upgrade, or the bounded retry budget spent with
   * nothing found. */
  readonly type: "usage_reconciled" | "usage_reconcile_exhausted";
  /** The `chat_usage` row this event is about. */
  readonly chatUsageId: string;
  /** When this composable observed the event (`Date.now()`), for watcher dedup/animation. */
  readonly receivedAt: number;
}

/** Lifecycle of the composable's live connection to one chat's `ChatAgent` Durable Object.
 * `"removed"` is distinct from `"error"`: it means the chat itself was deleted (its
 * `ChatAgent.destroy()` notified this connection, docs/06-AGENTIC-CHAT.md Section 11), not that
 * the connection merely failed -- the composable deliberately does not try to reconnect from
 * this state, since there is nothing left to reconnect to. */
export type ChatConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "removed"
  | "error";

/** Reactive surface this composable exposes; see `useChatAgent()`'s own JSDoc. */
export interface UseChatAgentResult {
  /** The full conversation held in the browser tab, in chronological order. */
  readonly turns: Readonly<ShallowRef<readonly ChatTurn[]>>;
  /** Lifecycle of the live WebSocket connection to the current chat. */
  readonly connectionStatus: Readonly<ShallowRef<ChatConnectionStatus>>;
  /** `true` while any turn is still streaming -- disables the composer's Send control. */
  readonly isStreaming: ComputedRef<boolean>;
  /**
   * Bumped to `Date.now()` each time the server broadcasts a `chat_metadata_updated` frame --
   * `ChatAgent.afterTurnCompleted()`'s own signal that its D1 writes (the recency touch, and
   * the first-turn title) have actually landed. A caller that owns the chat directory (the
   * sidebar) should watch this and reload from `GET /api/chats` when it changes, rather than
   * watching {@link isStreaming}: that flips to `false` on the turn's own `"finish"` UI part,
   * which the AI SDK enqueues as soon as the model itself finishes generating -- well before
   * this method's writes land, confirmed live (`docs/06-AGENTIC-CHAT.md` Section 11).
   */
  readonly metadataUpdatedAt: Readonly<ShallowRef<number>>;
  /**
   * This chat's current cost/token totals (docs/06-AGENTIC-CHAT.md Section 6.6a, Phase 6,
   * US-5) -- `ChatAgent.State.usage`, kept current automatically via the Agent WebSocket
   * protocol's own `cf_agent_state` frame (both on every push and on initial connect
   * hydration), never fetched separately. Zeroed ({@link emptyUsageSummary}) before the first
   * such frame arrives for this chat.
   */
  readonly usage: Readonly<ShallowRef<ChatUsageSummary>>;
  /**
   * The most recent reconciliation transition this chat has observed (Section 6.6a) --
   * `null` until the first one arrives for the current chat. A component should watch this
   * (rather than diffing {@link usage} itself) to know *when* to play a badge-flip animation,
   * since a change in `usage`'s numbers alone cannot distinguish "a new turn happened" from "an
   * estimate was just confirmed."
   */
  readonly lastReconciliationEvent: Readonly<
    ShallowRef<UsageReconciliationEvent | null>
  >;
  /**
   * Submit one new user turn. A no-op when `text` trims to empty, no chat is connected, or a
   * turn is already streaming (mirrors demo 5's `useChatStore.submit()` guard).
   *
   * @param text Raw composer text; trimmed before use.
   */
  send(text: string): void;
}

/** One part of a persisted `UIMessage`, as returned by the chat's `get-messages` REST endpoint.
 * `state`/`output`/`input` are only ever present on a persisted tool part (`type:
 * "tool-writeMarkdown"`/`"tool-activate_skill"`, per the `ai` SDK's own `ToolUIPart` shape) --
 * absent on a plain text part. */
interface PersistedMessagePart {
  type: string;
  text?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
}

/** One persisted `UIMessage`, as returned by the chat's `get-messages` REST endpoint. */
interface PersistedMessage {
  id: string;
  role: string;
  parts: readonly PersistedMessagePart[];
}

/** Concatenate every `"text"` part's text -- the only part shape Phase 2 renders. */
function extractText(parts: readonly PersistedMessagePart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Narrow an unknown tool `output` value to a successful `writeMarkdown` result shape
 * (`../../worker/agent/tools/write-markdown.ts`'s `WriteMarkdownOutput`), without importing a
 * Worker-only module into client code -- this composable's own convention of duplicating a
 * small shared shape rather than importing across the Worker/client boundary (mirrors this
 * file's own `ChatUsageSummary`). */
function asSuccessfulWriteMarkdownOutput(
  output: unknown,
): { fileId: string; filename: string } | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const candidate = output as Record<string, unknown>;
  return candidate.success === true &&
    typeof candidate.fileId === "string" &&
    typeof candidate.filename === "string"
    ? { fileId: candidate.fileId, filename: candidate.filename }
    : null;
}

/** Extract every successfully-attached `writeMarkdown` file from a persisted message's own
 * tool parts (docs/06-AGENTIC-CHAT.md Phase 9, US-8) -- a page reload's own source of truth for
 * a turn's attachments, mirroring how {@link extractText} already reconstructs a persisted
 * turn's text from the same `parts` array. */
function extractAttachments(
  parts: readonly PersistedMessagePart[],
): ChatFileAttachment[] {
  const attachments: ChatFileAttachment[] = [];
  for (const part of parts) {
    if (
      part.type !== "tool-writeMarkdown" ||
      part.state !== "output-available"
    ) {
      continue;
    }
    const result = asSuccessfulWriteMarkdownOutput(part.output);
    if (result !== null) {
      attachments.push({ fileId: result.fileId, filename: result.filename });
    }
  }
  return attachments;
}

/** Extract every skill the `activate_skill` tool activated from a persisted message's own tool
 * parts (docs/06-AGENTIC-CHAT.md Phase 11, US-10) -- a page reload's own source of truth for a
 * turn's activated skills, mirroring how {@link extractAttachments} already reconstructs a
 * persisted turn's attachments from the same `parts` array. Reads each part's `input` (the
 * tool-call *argument*, `{ name: "..." }` -- `agents/skills`'s `SkillRegistry.tools()`'s own
 * schema, Spike D Section 5), not `output`: unlike `writeMarkdown`'s result, `activate_skill`'s
 * own result text does not repeat the activated skill's name as a structured field. */
function extractActivatedSkills(
  parts: readonly PersistedMessagePart[],
): string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.type !== "tool-activate_skill") {
      continue;
    }
    const name = (part.input as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Convert one persisted message into a `"done"` turn. */
function toChatTurn(message: PersistedMessage): ChatTurn {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: extractText(message.parts),
    status: "done",
    errorDetail: null,
    attachments: extractAttachments(message.parts),
    activatedSkills: extractActivatedSkills(message.parts),
  };
}

/** One `cf_agent_use_chat_response` wire frame (docs/06-AGENTIC-CHAT.md Section 9, Spike A
 * Section 5). */
interface ChatResponseFrame {
  type: "cf_agent_use_chat_response";
  id: string;
  body: string;
  done: boolean;
  error?: boolean;
}

/** The full-history replay frame the server can send after a dropped-turn rollback. */
interface ChatMessagesFrame {
  type: "cf_agent_chat_messages";
  messages: readonly PersistedMessage[];
}

/** Bookkeeping this composable keeps per in-flight request while its response streams in. */
interface PendingRequest {
  assistantTurnId: string;
  decoder: UiMessageStreamDecoder;
}

/**
 * Fetch a chat's full persisted transcript from `AIChatAgent`'s own built-in `get-messages`
 * endpoint (forwarded by `src/worker/routes/chats.ts`), so a reloaded page repopulates from
 * durable storage rather than browser memory (US-1's acceptance criterion).
 *
 * @param chatId Chat to load.
 * @returns The chat's history, oldest first, every turn already `"done"`.
 * @throws {Error} When the request is rejected (for example a chat that no longer exists).
 */
async function fetchHistory(chatId: string): Promise<ChatTurn[]> {
  const response = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/get-messages`,
  );
  if (!response.ok) {
    throw new Error(`Failed to load chat history (status ${response.status}).`);
  }
  const messages = (await response.json()) as PersistedMessage[];
  return messages.map(toChatTurn);
}

/**
 * The **one** place this demo speaks the `AIChatAgent` WebSocket wire protocol
 * (docs/06-AGENTIC-CHAT.md Section 6.2a) -- every Pinia store and component consumes this
 * composable's reactive surface instead of `AgentClient` or a raw `WebSocket` directly, mirroring
 * `demos/chat`'s own single-seam rule for its socket-lifecycle store.
 *
 * Built directly on `agents/client`'s framework-agnostic `AgentClient` (confirmed by Spike A to
 * have no React dependency anywhere in its `PartySocket`/`ReconnectingWebSocket` chain), since
 * the Agents SDK's own documented hooks (`useAgent`/`useAgentChat`) live in the React-only
 * `agents/react`. `AgentClient`'s `basePath` option is used instead of its default
 * `agent`/`name` URL convention, matching this Worker's own custom `getAgentByName()` routing
 * (`src/worker/routes/chats.ts`) rather than `routeAgentRequest()`'s default. Because
 * `AgentClient` extends `ReconnectingWebSocket`, an unexpected drop reconnects automatically
 * (with backoff) with no reconnect logic of this composable's own -- unlike `demos/chat`'s
 * hand-rolled `room` store, which had to implement that itself on top of a raw `WebSocket`.
 *
 * @param chatId The chat to connect to. Accepts a plain string, ref, or getter
 * (`create-adaptable-composable` convention) so a caller can pass a reactive selection; `null`
 * disconnects and idles. Switching to a different id closes the previous connection and loads
 * the new chat's history before opening a new one.
 * @returns The reactive turns/connection-status/streaming/metadata surface, and a `send()`
 * method.
 */
export function useChatAgent(
  chatId: MaybeRefOrGetter<string | null>,
): UseChatAgentResult {
  const turns = shallowRef<readonly ChatTurn[]>([]);
  const connectionStatus = shallowRef<ChatConnectionStatus>("idle");
  const isStreaming = computed(() =>
    turns.value.some((turn) => turn.status === "streaming"),
  );
  const metadataUpdatedAt = shallowRef(0);
  const usage = shallowRef<ChatUsageSummary>(emptyUsageSummary());
  const lastReconciliationEvent = shallowRef<UsageReconciliationEvent | null>(
    null,
  );

  let client: AgentClient | null = null;
  const pendingRequests = new Map<string, PendingRequest>();
  // Maps a tool call's own id to the tool it invoked, populated from `tool-input-available` and
  // consumed by `tool-output-available`/`tool-output-error` (Phase 9, US-8) -- the wire
  // protocol's output-related chunks carry only `toolCallId`, never `toolName`, so this is the
  // only way to know a given output belongs to `writeMarkdown` specifically. Reset per chat
  // connection in `connect()`, matching every other piece of this composable's per-chat state.
  let toolNamesByCallId = new Map<string, string>();

  /** Replace one turn in {@link turns} with a shallow-merged patch, preserving array identity. */
  function patchTurn(id: string, patch: Partial<ChatTurn>): void {
    turns.value = turns.value.map((turn) =>
      turn.id === id ? { ...turn, ...patch } : turn,
    );
  }

  /** Append streamed text to an assistant turn's accumulated content. */
  function appendToTurn(id: string, delta: string): void {
    turns.value = turns.value.map((turn) =>
      turn.id === id ? { ...turn, content: turn.content + delta } : turn,
    );
  }

  /** Append one successfully-attached file to a turn's own {@link ChatTurn.attachments} list. */
  function appendAttachment(id: string, attachment: ChatFileAttachment): void {
    turns.value = turns.value.map((turn) =>
      turn.id === id
        ? { ...turn, attachments: [...turn.attachments, attachment] }
        : turn,
    );
  }

  /** Append one activated skill name to a turn's own {@link ChatTurn.activatedSkills} list, if
   * not already present (docs/06-AGENTIC-CHAT.md Phase 11, US-10). */
  function appendActivatedSkill(id: string, name: string): void {
    turns.value = turns.value.map((turn) =>
      turn.id === id && !turn.activatedSkills.includes(name)
        ? { ...turn, activatedSkills: [...turn.activatedSkills, name] }
        : turn,
    );
  }

  /** Apply one decoded UI-message-stream part to the turn its request produced. */
  function applyStreamPart(assistantTurnId: string, part: UiStreamPart): void {
    switch (part.type) {
      case "text-delta":
        // `UiStreamPart`'s catch-all `UnknownStreamPart` member has a `type: string` field that
        // overlaps every literal in this union, so `switch`/`if` narrowing on `type` alone can't
        // exclude it -- an explicit cast is required even after this literal comparison.
        appendToTurn(assistantTurnId, (part as { delta: string }).delta);
        return;
      case "tool-input-available": {
        const { toolCallId, toolName, input } = part as {
          toolCallId: string;
          toolName: string;
          input: unknown;
        };
        toolNamesByCallId.set(toolCallId, toolName);
        // `activate_skill`'s own activated name is a tool-call *argument*, not something its
        // later `tool-output-available` result repeats (docs/06-AGENTIC-CHAT.md Phase 11,
        // US-10) -- captured here, unlike `writeMarkdown`'s attachment below, which reads the
        // *output* instead since that is where its file id/filename actually live.
        if (toolName === "activate_skill") {
          const name = (input as { name?: unknown } | null)?.name;
          if (typeof name === "string") {
            appendActivatedSkill(assistantTurnId, name);
          }
        }
        return;
      }
      case "tool-output-available": {
        const { toolCallId, output } = part as {
          toolCallId: string;
          output: unknown;
        };
        if (toolNamesByCallId.get(toolCallId) !== "writeMarkdown") {
          return;
        }
        const result = asSuccessfulWriteMarkdownOutput(output);
        if (result !== null) {
          appendAttachment(assistantTurnId, {
            fileId: result.fileId,
            filename: result.filename,
          });
        }
        return;
      }
      case "error":
        patchTurn(assistantTurnId, {
          status: "error",
          errorDetail: (part as { errorText: string }).errorText,
        });
        return;
      case "finish":
        turns.value = turns.value.map((turn) =>
          turn.id === assistantTurnId && turn.status === "streaming"
            ? { ...turn, status: "done" }
            : turn,
        );
        return;
      default:
        return;
    }
  }

  /** Handle one `cf_agent_use_chat_response` frame, decoding and applying its `body` chunk. */
  function handleChatResponse(frame: ChatResponseFrame): void {
    const pending = pendingRequests.get(frame.id);
    if (!pending) {
      return;
    }
    for (const part of pending.decoder.push(frame.body)) {
      applyStreamPart(pending.assistantTurnId, part);
    }
    if (frame.error) {
      patchTurn(pending.assistantTurnId, {
        status: "error",
        errorDetail: "The agent reported an error.",
      });
    }
    if (frame.done) {
      pendingRequests.delete(frame.id);
      // Defensive: settle a turn that reached `done: true` with no explicit `finish` part.
      turns.value = turns.value.map((turn) =>
        turn.id === pending.assistantTurnId && turn.status === "streaming"
          ? { ...turn, status: "done" }
          : turn,
      );
    }
  }

  /** Raw WebSocket `message` handler -- ignores every frame type this composable does not act
   * on (identity, MCP-server, state; `AgentClient` itself already consumes state/identity/rpc
   * frames independently of this listener, per Spike A Section 8). */
  function handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(event.data) as { type?: string };
    } catch {
      return;
    }
    if (parsed.type === "cf_agent_use_chat_response") {
      handleChatResponse(parsed as ChatResponseFrame);
    } else if (parsed.type === "cf_agent_chat_messages") {
      turns.value = (parsed as ChatMessagesFrame).messages.map(toChatTurn);
    } else if (parsed.type === "chat_removed") {
      handleRemoval();
    } else if (parsed.type === "chat_metadata_updated") {
      metadataUpdatedAt.value = Date.now();
    } else if (
      parsed.type === "usage_reconciled" ||
      parsed.type === "usage_reconcile_exhausted"
    ) {
      // `usage` itself is already current by the time either of these arrives -- the server
      // always calls `setState()` before `broadcast()` for the same transition
      // (`ChatAgent.reconcileUsage()`) -- this event exists purely so a badge can animate the
      // specific Estimated -> AI Gateway (or -> exhausted) transition (Section 6.6a).
      lastReconciliationEvent.value = {
        type: parsed.type,
        chatUsageId: (parsed as { chatUsageId: string }).chatUsageId,
        receivedAt: Date.now(),
      };
    }
  }

  /**
   * Handle the server force-closing this connection because the chat itself was deleted
   * (`ChatAgent.destroy()`, docs/06-AGENTIC-CHAT.md Section 11) -- distinct from a transient
   * drop, so the connection must not be allowed to reconnect into a chat that no longer exists.
   * Idempotent: safe to call once from the `chat_removed` message handler and again (as a
   * belt-and-suspenders fallback, in case the message frame never arrives) from the "close"
   * listener's own {@link CHAT_REMOVED_CLOSE_CODE} check.
   */
  function handleRemoval(): void {
    connectionStatus.value = "removed";
    teardown();
  }

  /** Close and forget the current connection, if any. Safe to call when already idle. */
  function teardown(): void {
    const socket = client;
    client = null;
    pendingRequests.clear();
    socket?.close();
  }

  /** Load history and open a live connection for `id`. */
  async function connect(id: string, isStale: () => boolean): Promise<void> {
    connectionStatus.value = "connecting";
    turns.value = [];
    usage.value = emptyUsageSummary();
    lastReconciliationEvent.value = null;
    toolNamesByCallId = new Map();

    let history: ChatTurn[];
    try {
      history = await fetchHistory(id);
    } catch {
      if (!isStale()) {
        connectionStatus.value = "error";
      }
      return;
    }
    if (isStale()) {
      return;
    }
    turns.value = history;

    const socket = new AgentClient({
      agent: "ChatAgent",
      basePath: `api/chats/${encodeURIComponent(id)}/ws`,
      host: window.location.host,
      // The Agent WebSocket protocol's own `cf_agent_state` frame -- delivered both on initial
      // connect (hydrating whatever this chat's state already is) and on every later
      // `setState()` push (docs/06-AGENTIC-CHAT.md Section 6.6a). This is `AgentClient`'s own
      // documented hook for exactly this, rather than re-parsing the frame in `handleMessage`
      // (which never sees it as a distinct case to act on -- `AgentClient`'s own internal
      // "message" listener already updates `socket.state` and fires this callback for it,
      // independent of and in addition to this composable's own listener, per Spike A Section
      // 8; both listeners see every frame, since neither stops propagation).
      onStateUpdate: (state) => {
        usage.value = (state as { usage: ChatUsageSummary }).usage;
      },
    });
    client = socket;

    // No `client === socket` staleness guard is needed on "open"/"error": `ReconnectingWebSocket`
    // (which `AgentClient` extends) synchronously removes its underlying raw-socket listeners
    // inside `close()`/`_disconnect()`, called from this composable's own `teardown()` before
    // `client` is ever reassigned to a newer socket -- so a torn-down socket structurally cannot
    // deliver a further "open"/"error" event at all, not merely one this composable should
    // ignore. "close" is different and does need the guard: `_disconnect()` calls its own
    // `_handleClose()` directly (not via a raw-socket listener), synchronously, from inside the
    // very `socket.close()` call `teardown()` itself makes -- so this composable's own "close"
    // listener genuinely does fire for its own teardown, immediately after `client` has already
    // been nulled, and must not be mistaken for an unexpected drop.
    socket.addEventListener("open", () => {
      connectionStatus.value = "connected";
    });
    socket.addEventListener("close", (event) => {
      if (client !== socket) {
        return;
      }
      if (event.code === CHAT_REMOVED_CLOSE_CODE) {
        // Belt-and-suspenders alongside the "chat_removed" message-frame path above: reachable
        // only if that frame never arrived before the close (see `agent-protocol.ts`).
        handleRemoval();
        return;
      }
      connectionStatus.value = "connecting";
    });
    socket.addEventListener("error", () => {
      connectionStatus.value = "error";
    });
    socket.addEventListener("message", handleMessage);
  }

  watch(
    () => toValue(chatId),
    (id, _previous, onCleanup) => {
      let stale = false;
      onCleanup(() => {
        stale = true;
        teardown();
      });
      if (id === null) {
        turns.value = [];
        connectionStatus.value = "idle";
        return;
      }
      void connect(id, () => stale);
    },
    { immediate: true },
  );

  onScopeDispose(() => teardown());

  /** @see {@link UseChatAgentResult.send} */
  function send(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0 || client === null || isStreaming.value) {
      return;
    }

    const requestId = crypto.randomUUID();
    const userTurnId = crypto.randomUUID();
    const assistantTurnId = crypto.randomUUID();

    turns.value = [
      ...turns.value,
      {
        id: userTurnId,
        role: "user",
        content: trimmed,
        status: "done",
        errorDetail: null,
        attachments: [],
        activatedSkills: [],
      },
      {
        id: assistantTurnId,
        role: "assistant",
        content: "",
        status: "streaming",
        errorDetail: null,
        attachments: [],
        activatedSkills: [],
      },
    ];
    pendingRequests.set(requestId, {
      assistantTurnId,
      decoder: new UiMessageStreamDecoder(),
    });

    client.send(
      JSON.stringify({
        type: "cf_agent_use_chat_request",
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                id: userTurnId,
                role: "user",
                parts: [{ type: "text", text: trimmed }],
              },
            ],
            trigger: "submit-message",
          }),
        },
      }),
    );
  }

  return {
    turns,
    connectionStatus,
    isStreaming,
    metadataUpdatedAt,
    usage,
    lastReconciliationEvent,
    send,
  };
}
