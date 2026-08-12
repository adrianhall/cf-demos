import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphOperation } from "../../graph-mutations";
import type { DocumentationResult } from "../../worker/ai/docs-client";
import { describeOperation } from "../lib/describe-operation";
import { useDiagramStore } from "../stores/diagramStore";

/** A `graph_snapshot` frame -- sent once, immediately on connect, and again after a whole-graph
 * replace (`../../worker/diagram-session/diagram-session.ts`'s `applyWholeGraphReplace()`). */
interface GraphSnapshotMessage {
  type: "graph_snapshot";
  graphData: string;
  sequence: number;
}

/** An `operation_applied` frame -- broadcast to every connection, including the originator.
 * `origin: "ai-chat"` (docs/09D-ARCHITECT-AICHAT.md) widens 9C's original `"human" | "agent"`
 * for a graph mutation performed by an AI chat tool call. */
interface OperationAppliedMessage {
  type: "operation_applied";
  clientOpId?: string;
  actorEmail: string;
  origin: "human" | "agent" | "ai-chat";
  op: GraphOperation;
  sequence: number;
}

/** An `operation_rejected` frame -- sent only to the connection whose own operation targeted a
 * node/edge another operation already removed in the meantime. */
interface OperationRejectedMessage {
  type: "operation_rejected";
  clientOpId?: string;
  reason: string;
}

/** A `presence_snapshot` frame -- sent once, immediately on connect, alongside `graph_snapshot`
 * (docs/09C-COLLABORATIVE-EDITING.md's Phase 19). */
interface PresenceSnapshotMessage {
  type: "presence_snapshot";
  participants: { email: string; displayName: string | null; color: string }[];
}

/** A `presence_joined` frame -- broadcast to every other connection when an identity's first
 * connection opens. */
interface PresenceJoinedMessage {
  type: "presence_joined";
  email: string;
  displayName: string | null;
  color: string;
}

/** A `presence_left` frame -- broadcast to every remaining connection when an identity's last
 * connection closes. */
interface PresenceLeftMessage {
  type: "presence_left";
  email: string;
}

/** A `cursor_moved` frame relayed from another connection, with `email` added by the server. */
interface CursorMovedMessage {
  type: "cursor_moved";
  email: string;
  x: number;
  y: number;
}

/** A `selection_changed` frame relayed from another connection, with `email` added by the
 * server. */
interface SelectionChangedMessage {
  type: "selection_changed";
  email: string;
  nodeId: string | null;
  edgeId: string | null;
}

/** Narrow an arbitrary decoded frame down to {@link GraphSnapshotMessage}. */
function isGraphSnapshotMessage(value: unknown): value is GraphSnapshotMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "graph_snapshot" &&
    typeof (value as { graphData?: unknown }).graphData === "string" &&
    typeof (value as { sequence?: unknown }).sequence === "number"
  );
}

/** Narrow an arbitrary decoded frame down to {@link OperationAppliedMessage}. */
function isOperationAppliedMessage(
  value: unknown,
): value is OperationAppliedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "operation_applied" &&
    typeof (value as { actorEmail?: unknown }).actorEmail === "string" &&
    ((value as { origin?: unknown }).origin === "human" ||
      (value as { origin?: unknown }).origin === "agent" ||
      (value as { origin?: unknown }).origin === "ai-chat") &&
    typeof (value as { op?: unknown }).op === "object" &&
    (value as { op?: unknown }).op !== null &&
    typeof (value as { sequence?: unknown }).sequence === "number"
  );
}

/** Narrow an arbitrary decoded frame down to {@link OperationRejectedMessage}. */
function isOperationRejectedMessage(
  value: unknown,
): value is OperationRejectedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "operation_rejected"
  );
}

/** Narrow an arbitrary decoded frame down to {@link PresenceSnapshotMessage}. */
function isPresenceSnapshotMessage(
  value: unknown,
): value is PresenceSnapshotMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "presence_snapshot" &&
    Array.isArray((value as { participants?: unknown }).participants)
  );
}

/** Narrow an arbitrary decoded frame down to {@link PresenceJoinedMessage}. */
function isPresenceJoinedMessage(
  value: unknown,
): value is PresenceJoinedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "presence_joined" &&
    typeof (value as { email?: unknown }).email === "string" &&
    typeof (value as { color?: unknown }).color === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link PresenceLeftMessage}. */
function isPresenceLeftMessage(value: unknown): value is PresenceLeftMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "presence_left" &&
    typeof (value as { email?: unknown }).email === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link CursorMovedMessage}. */
function isCursorMovedMessage(value: unknown): value is CursorMovedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cursor_moved" &&
    typeof (value as { email?: unknown }).email === "string" &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  );
}

/** Narrow an arbitrary decoded frame down to {@link SelectionChangedMessage}. */
function isSelectionChangedMessage(
  value: unknown,
): value is SelectionChangedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "selection_changed" &&
    typeof (value as { email?: unknown }).email === "string"
  );
}

/** A `chat_status` frame -- unicast progress narration for one AI chat turn
 * (docs/09D-ARCHITECT-AICHAT.md's Message Protocol), e.g. "Checking Cloudflare docs…". */
interface ChatStatusMessage {
  type: "chat_status";
  clientRequestId: string;
  message: string;
}

/** A `chat_token` frame -- one streamed chunk of a chat turn's final natural-language answer,
 * unicast to the connection that sent the originating `chat_message`. */
interface ChatTokenMessage {
  type: "chat_token";
  clientRequestId: string;
  text: string;
}

/** A `chat_tool_result` frame -- unicast, sent only for the `search_cloudflare_documentation`
 * tool (a graph-mutating tool's effect arrives as an ordinary {@link OperationAppliedMessage}
 * instead). `result` is `DocumentationResult[]` on a successful docs lookup or `{ message }` on
 * `../../worker/ai/docs-client.ts`'s non-fatal "documentation search is currently unavailable"
 * fallback -- see `../../worker/diagram-session/diagram-session.ts`'s own top-of-file JSDoc for
 * this exact contract. */
interface ChatToolResultMessage {
  type: "chat_tool_result";
  clientRequestId: string;
  tool: "search_cloudflare_documentation";
  args: { query: string };
  result: DocumentationResult[] | { message: string };
}

/** A `chat_done` frame -- unicast, sent once a chat turn completes successfully, carrying its
 * complete final answer (`assistantText`) as a reconciliation point against whatever partial
 * text this tab already accumulated from {@link ChatTokenMessage} frames. */
interface ChatDoneMessage {
  type: "chat_done";
  clientRequestId: string;
  assistantText: string;
}

/** A `chat_error` frame -- unicast, sent instead of {@link ChatDoneMessage} when a chat turn
 * threw. Never accompanies a crashed connection or object -- see
 * `../../worker/diagram-session/diagram-session.ts`'s `handleChatMessage()` JSDoc. */
interface ChatErrorMessage {
  type: "chat_error";
  clientRequestId: string;
  message: string;
}

/** A `diagram_renamed` frame -- **broadcast** to every connection (unlike every other AI chat
 * frame above, which is unicast) when a `rename_diagram` AI chat tool call changes the
 * diagram's title/description. */
interface DiagramRenamedMessage {
  type: "diagram_renamed";
  title: string;
  description: string | null;
}

/** Narrow an arbitrary decoded frame down to {@link ChatStatusMessage}. */
function isChatStatusMessage(value: unknown): value is ChatStatusMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_status" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link ChatTokenMessage}. */
function isChatTokenMessage(value: unknown): value is ChatTokenMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_token" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link ChatToolResultMessage}. */
function isChatToolResultMessage(
  value: unknown,
): value is ChatToolResultMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_tool_result" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { args?: { query?: unknown } }).args?.query === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link ChatDoneMessage}. */
function isChatDoneMessage(value: unknown): value is ChatDoneMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_done" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { assistantText?: unknown }).assistantText === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link ChatErrorMessage}. */
function isChatErrorMessage(value: unknown): value is ChatErrorMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_error" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Narrow an arbitrary decoded frame down to {@link DiagramRenamedMessage}. */
function isDiagramRenamedMessage(
  value: unknown,
): value is DiagramRenamedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "diagram_renamed" &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

/** Minimum interval, in milliseconds, between outgoing `cursor_moved` frames --
 * docs/09C-COLLABORATIVE-EDITING.md's Phase 19 "Client-throttled (~15/sec)" requirement.
 * `1000 / 15 ≈ 67`, rounded to a plain `65` for a slightly more generous (not slower) cap. */
const CURSOR_THROTTLE_MS = 65;

/** Build the same-origin WebSocket URL for a diagram's live-sync upgrade route. */
function liveSyncUrl(diagramId: string): URL {
  const url = new URL(
    `/api/diagrams/${encodeURIComponent(diagramId)}/live`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * One entry in the AI chat panel's transcript (`../components/editor/panels/AiChatPanel.tsx`,
 * docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat), in arrival order. `id` is a value local to this
 * hook (see {@link nextTranscriptEntryId}), used only as a React list key and as this hook's own
 * pointer to "the assistant entry a `chat_token` should append to" -- it has no meaning outside
 * this tab.
 *
 * - `"user"`/`"assistant"`: the plain conversational text exchanged this turn. An `"assistant"`
 *   entry's `text` accumulates from streamed {@link ChatTokenMessage} frames and is reconciled to
 *   the turn's complete answer on {@link ChatDoneMessage} -- unless `stopped` is `true`, in which
 *   case it is left exactly as the user last saw it; see {@link DiagramLiveSync.stopChatTurn}.
 * - `"status"`: a `chat_status` progress narration line ("Checking Cloudflare docs…").
 * - `"docs_result"`: a `chat_tool_result` frame's `search_cloudflare_documentation` outcome.
 * - `"error"`: a `chat_error` frame's message.
 * - `"action"`: a compact narration of one `operation_applied` (`origin: "ai-chat"`) broadcast,
 *   computed by `../lib/describe-operation.ts`'s `describeOperation()` -- rendered for **every**
 *   connected tab with a chat panel, not only the one that sent the triggering `chat_message`
 *   (docs/09D-ARCHITECT-AICHAT.md's Phase 24 plan: "operation_applied entries filtered to
 *   `origin: 'ai-chat'` for its own transcript").
 */
export type ChatTranscriptEntry = { id: string } & (
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; stopped: boolean }
  | { kind: "status"; text: string }
  | {
      kind: "docs_result";
      query: string;
      result: DocumentationResult[] | { message: string };
    }
  | { kind: "error"; text: string }
  | { kind: "action"; text: string }
);

/** Monotonically increasing counter backing {@link nextTranscriptEntryId} -- mirrors
 * `../stores/diagramStore.ts`'s `nextClientOpId()` precedent: this id only needs to be unique
 * for the lifetime of one browser tab (a React list key and this hook's own bookkeeping), never
 * persisted or compared across tabs. */
let transcriptEntryCounter = 0;

/** Generate a locally-unique id for the next {@link ChatTranscriptEntry}. */
function nextTranscriptEntryId(): string {
  transcriptEntryCounter += 1;
  return `chat-entry-${transcriptEntryCounter}`;
}

/** What {@link useDiagramLiveSync} exposes to `../components/editor/DiagramCanvas.tsx`. */
export interface DiagramLiveSync {
  /** Whether the socket's `open` event has fired and it has not since closed/errored. Gates
   * `DiagramCanvas.tsx`'s fallback to the `PUT`-based autosave: that fallback runs only while
   * this is `false`. */
  connected: boolean;
  /**
   * Send one discrete operation over the live socket, tracking `clientOpId` as "pending" so a
   * later `operation_applied`/`operation_rejected` echo carrying the same id can be reconciled
   * against this tab's own optimistic local edit instead of being re-applied or surfaced as a
   * remote change.
   *
   * @param op The operation to send.
   * @param clientOpId This tab's own id for this operation.
   * @returns Whether the frame was actually sent (`false` when the socket is not open) --
   * callers fall back to the REST autosave when this is `false`.
   */
  sendOperation: (op: GraphOperation, clientOpId: string) => boolean;
  /** Every other identity currently connected to this diagram, keyed by email -- seeded by
   * `presence_snapshot` and kept current by `presence_joined`/`presence_left`
   * (docs/09C-COLLABORATIVE-EDITING.md's Phase 19). Never includes this tab's own identity. */
  participants: Record<
    string,
    { email: string; displayName: string | null; color: string }
  >;
  /** Each other identity's last reported cursor position, keyed by email -- updated by
   * incoming `cursor_moved` frames, and removed the instant that identity's `presence_left`
   * arrives so a departed identity's cursor never lingers on the canvas. */
  cursors: Record<string, { x: number; y: number; color: string }>;
  /** Each other identity's current node/edge selection, keyed by email -- updated by incoming
   * `selection_changed` frames (using that identity's already-known `color` from
   * {@link DiagramLiveSync.participants}), and removed on `presence_left` for the same reason
   * as {@link DiagramLiveSync.cursors}. */
  remoteSelections: Record<
    string,
    { nodeId: string | null; edgeId: string | null; color: string }
  >;
  /**
   * Send this tab's own cursor position, client-throttled to roughly 15/sec
   * (`CURSOR_THROTTLE_MS`). Silently does nothing when the socket is not open or the throttle
   * window has not elapsed -- fire-and-forget, never queued (docs/09C-COLLABORATIVE-EDITING.md's
   * Message Protocol: "dropped entirely... rather than queued").
   *
   * @param x Flow-space x coordinate.
   * @param y Flow-space y coordinate.
   */
  sendCursor: (x: number, y: number) => void;
  /**
   * Send this tab's own current node/edge selection. Not throttled -- selection changes are
   * infrequent. Silently does nothing when the socket is not open.
   *
   * @param nodeId The currently selected node's id, or `null` if none/an edge is selected.
   * @param edgeId The currently selected edge's id, or `null` if none/a node is selected.
   */
  sendSelectionChange: (nodeId: string | null, edgeId: string | null) => void;
  /** The AI chat transcript accumulated on this connection so far, in arrival order --
   * `../components/editor/panels/AiChatPanel.tsx`'s entire rendering input. Reset to `[]`
   * whenever the diagram id changes (a fresh diagram means a fresh connection and a fresh
   * conversation), but *not* simply by a chat turn completing -- only
   * {@link DiagramLiveSync.clearChatTranscript} ("New conversation") or a diagram change clears
   * it. */
  chatTranscript: ChatTranscriptEntry[];
  /** Whether this tab has a `chat_message` awaiting its own `chat_done`/`chat_error`. Drives the
   * chat panel's composer (disables Send, shows Stop) -- see
   * {@link DiagramLiveSync.sendChatMessage}/{@link DiagramLiveSync.stopChatTurn}. */
  chatInFlight: boolean;
  /**
   * Send one AI chat message over the live socket (docs/09D-ARCHITECT-AICHAT.md's Message
   * Protocol), appending a `"user"` entry to {@link DiagramLiveSync.chatTranscript} and setting
   * {@link DiagramLiveSync.chatInFlight}.
   *
   * @param text The message text sent to the model.
   * @param displayText What to show in the transcript instead of `text`, when the two differ.
   * `GenerateWithAiModal` wraps the user's own one-line description in a much longer
   * instruction for the model ("Propose an initial Cloudflare architecture using only the
   * available product types…"); echoing that whole synthesized prompt back as the user's own
   * message read as machine noise, so it passes the plain description here. Defaults to `text`,
   * which is what an ordinary chat message wants.
   * @returns The generated `clientRequestId` on success, or `false` when the socket is not open
   * (mirroring {@link DiagramLiveSync.sendOperation}'s own not-connected return value) -- the
   * caller is not required to do anything with the id, since this hook already tracks the
   * resulting transcript centrally, but it is returned in case a future caller wants its own
   * correlation.
   */
  sendChatMessage: (text: string, displayText?: string) => string | false;
  /**
   * Stop rendering further `chat_token`s for the turn currently in flight, and mark its
   * `"assistant"` transcript entry as `stopped`. **This is "stop watching," not "cancel the
   * model"**: `../../worker/diagram-session/diagram-session.ts` has no cancellation frame in its
   * protocol at all (confirmed by reading its own `webSocketMessage()`/`handleChatMessage()`
   * implementation -- there is no inbound frame type this hook could send to interrupt an
   * in-flight `runDiagramChatTurn()` call), so the turn keeps running to completion on the
   * server exactly as docs/09D-ARCHITECT-AICHAT.md's own resilience design already describes for
   * an abandoned/disconnected connection; any further tool-call mutations it makes still arrive
   * as ordinary `operation_applied` broadcasts and are still applied to the canvas. Only this
   * tab's own rendering of the turn's remaining narration/final text is suppressed. Does nothing
   * if no turn is currently in flight.
   */
  stopChatTurn: () => void;
  /** Clear this tab's own local {@link DiagramLiveSync.chatTranscript} ("New conversation",
   * docs/09D-ARCHITECT-AICHAT.md's Chat panel UI). Deliberately does **not** reset
   * `../../worker/diagram-session/diagram-session.ts`'s own per-connection `chatHistories` entry
   * -- there is no frame in this protocol that could ask it to, since every existing frame type
   * either sends a new turn or reports one's outcome; see this hook's own top-of-file JSDoc for
   * the resulting, accepted gap between this and the design doc's own stated behavior. */
  clearChatTranscript: () => void;
}

/**
 * Open a bidirectional WebSocket to the diagram's `DiagramSession` Durable Object
 * (`../../worker/diagram-session/diagram-session.ts`, docs/09C-COLLABORATIVE-EDITING.md's
 * Live-Editing Architecture) for as long as this hook stays mounted.
 *
 * On `graph_snapshot`, replaces the store's `nodes`/`edges`/`viewport` wholesale and clears
 * `dirty`/undo history, exactly like the previous `graph_updated` push did -- but compares
 * `sequence` (an in-memory, per-connection counter) instead of `updatedAt`, since a snapshot
 * frame carries no timestamp; a snapshot whose `sequence` is lower than one already seen on this
 * connection is ignored, tolerating an out-of-order low-level delivery even though one WebSocket
 * connection delivers frames in order in practice.
 *
 * On `operation_applied`: if `clientOpId` matches one of this tab's own still-pending sent
 * operations, the pending entry is simply cleared (the local optimistic edit already reflects
 * it) -- except when `origin === "agent"`, which still surfaces the "Updated by your agent"
 * toast even for this tab's own echoed operation, since an MCP tool call authenticates as the
 * same identity as a signed-in owner (docs/09C-COLLABORATIVE-EDITING.md's Interplay With Demo
 * 9B). Otherwise (an operation that did not originate from one of this tab's own pending sends),
 * the operation is applied to local state via the shared `applyGraphOperation()`
 * (`../../graph-mutations.ts`) and the toast is surfaced. An `origin: "ai-chat"` operation
 * (docs/09D-ARCHITECT-AICHAT.md) is never one of this tab's own *pending* sends (an AI-chat-
 * triggered `applyOperation()` call passes no `clientOpId` at all -- see
 * `../../worker/diagram-session/diagram-session.ts`'s `handleChatMessage()`), so it is always
 * applied to local state exactly like a remote human/agent edit, on **every** connected tab
 * including the one that is chatting -- this is the entire mechanism by which a passive
 * collaborator sees the assistant's edits live with no chat-specific canvas code at all. Every
 * `origin: "ai-chat"` operation also appends an `"action"` entry to
 * {@link DiagramLiveSync.chatTranscript} (`../lib/describe-operation.ts`), computed from the
 * graph as it stood *before* this mutation, on every connected tab -- not only the one chatting.
 *
 * **Toast suppression for the chatting tab** (docs/09D-ARCHITECT-AICHAT.md's Message Protocol:
 * "9C's existing 'Updated by…' toast is suppressed for the connection that originated a
 * `chat_message`... and shown, unchanged, to every other connection"). The design doc states this
 * intent in one sentence with no fully specified mechanism -- an `origin: "ai-chat"` operation
 * has no `clientOpId` to reconcile against the way a `"human"` echo does, so the existing
 * `isOwnPendingOperation` check can never distinguish "this tab is the one chatting" from "this
 * tab is a passive viewer" for this origin. This hook's own heuristic: track whether this tab
 * currently has a `chat_message` awaiting its own `chat_done`/`chat_error`
 * ({@link DiagramLiveSync.chatInFlight}, via `activeChatRequestIdRef` below). An `origin:
 * "ai-chat"` `operation_applied` broadcast arriving while that ref is non-`null` is suppressed
 * (this tab already sees the change happen in its own chat transcript's `"action"` entry); one
 * arriving while it is `null` (this tab has no turn in flight -- either it never chatted at all,
 * or its own last turn already resolved) shows the toast normally. This is a simple, deliberately
 * chosen approximation, not a precise per-turn correlation: a tab is treated as "the chatting
 * tab" for every `ai-chat` broadcast that happens to arrive during *any* of its own in-flight
 * turns, not specifically the turn that produced a given mutation -- indistinguishable in
 * practice, since this UI disables sending a second message while one is already in flight, so
 * at most one turn per tab is ever in flight at a time.
 *
 * On `operation_rejected`, the matching pending entry is simply dropped -- no toast, no other
 * reconciliation, since every other broadcast this tab has already received reflects current
 * truth by the time a rejection arrives.
 *
 * On `presence_snapshot`, seeds {@link DiagramLiveSync.participants} wholesale; `presence_joined`/
 * `presence_left` add/remove one entry at a time afterward. `presence_left` for an email also
 * removes that email's entries from {@link DiagramLiveSync.cursors}/
 * {@link DiagramLiveSync.remoteSelections}, so a departed identity's stale cursor/selection
 * never lingers on the canvas. `cursor_moved`/`selection_changed` update those two maps directly,
 * keyed by the `email` the server adds to each relayed frame.
 *
 * **AI chat frames** (docs/09D-ARCHITECT-AICHAT.md's Message Protocol; see
 * `../../worker/diagram-session/diagram-session.ts`'s own top-of-file JSDoc for the authoritative
 * wire contract this hook implements the client side of): `chat_status`/`chat_tool_result`
 * append a `"status"`/`"docs_result"` {@link ChatTranscriptEntry} directly. `chat_token`
 * accumulates onto the in-flight turn's own `"assistant"` entry (creating it on the first token),
 * unless {@link DiagramLiveSync.stopChatTurn} already marked that entry `stopped`, in which case
 * further tokens for that `clientRequestId` are silently dropped. `chat_done` reconciles that
 * entry's text to the frame's own complete `assistantText` (again, unless `stopped`) and clears
 * {@link DiagramLiveSync.chatInFlight}; `chat_error` appends an `"error"` entry and does the same.
 * `diagram_renamed` calls `../stores/diagramStore.ts`'s `applyRemoteRename()` -- not the plain
 * `setTitle`/`setDescription`, since this diagram's title/description were already persisted by
 * the `rename_diagram` tool call that produced this broadcast before it was ever sent.
 *
 * **Known gap**: `../components/editor/panels/AiChatPanel.tsx`'s "New conversation" control
 * (via {@link DiagramLiveSync.clearChatTranscript}) clears only this hook's own local
 * `chatTranscript` state. docs/09D-ARCHITECT-AICHAT.md's own Chat panel UI section describes this
 * as implicitly restarting the *server's* per-connection history too ("the next `chat_message`
 * sent starts the object's own history over too, since both are scoped to the same connection"),
 * but that description appears to assume a fresh connection (a disconnect/reconnect), not a
 * same-connection button click: `../../worker/diagram-session/diagram-session.ts`'s
 * `handleChatMessage()` has no frame or mechanism that resets `this.chatHistories` for a live
 * connection short of it actually closing. This hook cannot close and reopen the socket just to
 * honor "New conversation" without also dropping every other piece of this connection's state
 * (presence, pending operations), so this is accepted as a known, minor, documented mismatch
 * between the design doc's stated behavior and the current protocol's actual capability -- not a
 * bug this phase attempts to fix, per docs/09D-ARCHITECT-AICHAT.md's own explicit non-goal of
 * persistent chat history (a same-connection stale/growing history is a strictly smaller problem
 * than the persistence that non-goal already declines to build).
 *
 * @param diagramId Diagram id to open a live connection for, or `null` before one has loaded.
 * @param enabled Whether to actually open the connection. Callers disable this for the
 * read-only, anonymous share viewer (`../views/ShareView.tsx`), which authenticates via a share
 * token rather than a Cloudflare Access identity and could never pass this route's access check.
 */
export function useDiagramLiveSync(
  diagramId: string | null,
  enabled: boolean,
): DiagramLiveSync {
  const [connected, setConnected] = useState(false);
  const [participants, setParticipants] = useState<
    DiagramLiveSync["participants"]
  >({});
  const [cursors, setCursors] = useState<DiagramLiveSync["cursors"]>({});
  const [remoteSelections, setRemoteSelections] = useState<
    DiagramLiveSync["remoteSelections"]
  >({});
  const [chatTranscript, setChatTranscript] = useState<ChatTranscriptEntry[]>(
    [],
  );
  const [chatInFlight, setChatInFlight] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  // Ids this tab has itself sent and not yet reconciled via an `operation_applied`/
  // `operation_rejected` echo. A plain ref, not store state: purely local socket-reconciliation
  // bookkeeping with no reason to be shared app state or trigger a re-render on its own.
  const pendingClientOpIdsRef = useRef<Set<string>>(new Set());
  const highestSequenceRef = useRef(0);
  // Timestamp (`Date.now()`) of the most recently *sent* `cursor_moved` frame -- the minimum-
  // interval gate behind `sendCursor()`'s ~15/sec client-side throttle.
  const lastCursorSentAtRef = useRef(0);
  // The `clientRequestId` of this tab's own chat turn currently awaiting `chat_done`/
  // `chat_error`, or `null` when none is in flight -- both this hook's own "chatInFlight" signal
  // and the toast-suppression heuristic's own state (see this hook's own top-of-file JSDoc).
  const activeChatRequestIdRef = useRef<string | null>(null);
  // The transcript entry id the in-flight turn's `chat_token`s are currently accumulating onto,
  // or `null` before the first token of this turn has arrived -- and also `null` again after any
  // status/action/docs entry interrupts the stream, so the next token opens a *new* bubble
  // beneath that entry (see `appendInterruptingEntry`).
  const activeAssistantEntryIdRef = useRef<string | null>(null);
  // Whether this turn has streamed at least one `chat_token`, which decides whether `chat_done`
  // needs to record the answer itself -- see its own handler.
  const streamedAnyTokenRef = useRef(false);
  // `clientRequestId`s `stopChatTurn()` has marked "stop watching" -- further `chat_token`s for
  // these ids are dropped, and their eventual `chat_done`/`chat_error` is consumed silently
  // rather than re-appended to the transcript a second time.
  const stoppedRequestIdsRef = useRef<Set<string>>(new Set());

  const applyRemoteGraphSnapshot = useDiagramStore(
    (state) => state.applyRemoteGraphSnapshot,
  );
  const applyRemoteOperation = useDiagramStore(
    (state) => state.applyRemoteOperation,
  );
  const showLiveUpdateNotice = useDiagramStore(
    (state) => state.showLiveUpdateNotice,
  );
  const applyRemoteRename = useDiagramStore((state) => state.applyRemoteRename);

  useEffect(() => {
    if (!enabled || diagramId === null) {
      setConnected(false);
      return;
    }

    highestSequenceRef.current = 0;
    pendingClientOpIdsRef.current.clear();
    lastCursorSentAtRef.current = 0;
    activeChatRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    stoppedRequestIdsRef.current.clear();
    setParticipants({});
    setCursors({});
    setRemoteSelections({});
    setChatTranscript([]);
    setChatInFlight(false);

    const socket = new WebSocket(liveSyncUrl(diagramId));
    socketRef.current = socket;

    const onOpen = () => setConnected(true);
    const onClosedOrErrored = () => setConnected(false);

    /**
     * Append one non-assistant transcript entry and close out any assistant bubble currently
     * being streamed onto.
     *
     * Closing the bubble is what keeps the transcript in chronological order. A turn typically
     * narrates ("Now I'll wire everything together:"), calls tools, then narrates again -- and
     * because every entry here is a plain end-append while the assistant bubble stays anchored
     * wherever its first token landed, later prose kept flowing *into that earlier bubble*, so
     * the turn's closing summary appeared above the tool activity that preceded it. Clearing the
     * anchor makes the next token open a fresh bubble below this entry instead
     * (docs/DECISIONS.md #43).
     */
    const appendInterruptingEntry = (entry: ChatTranscriptEntry) => {
      activeAssistantEntryIdRef.current = null;
      setChatTranscript((current) => [...current, entry]);
    };

    const onMessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (isGraphSnapshotMessage(parsed)) {
        if (parsed.sequence < highestSequenceRef.current) return;
        highestSequenceRef.current = parsed.sequence;
        applyRemoteGraphSnapshot(parsed.graphData);
        return;
      }

      if (isOperationAppliedMessage(parsed)) {
        highestSequenceRef.current = Math.max(
          highestSequenceRef.current,
          parsed.sequence,
        );

        const isOwnPendingOperation =
          parsed.clientOpId !== undefined &&
          pendingClientOpIdsRef.current.has(parsed.clientOpId);
        if (isOwnPendingOperation && parsed.clientOpId !== undefined) {
          pendingClientOpIdsRef.current.delete(parsed.clientOpId);
        }

        if (isOwnPendingOperation && parsed.origin !== "agent") {
          // Already applied optimistically by this tab -- no re-application needed.
          return;
        }

        if (parsed.origin === "ai-chat") {
          // Describe the action using the graph as it stood *before* this mutation -- a
          // remove_node/remove_edge operation's own target is gone from the store the instant
          // `applyRemoteOperation` below runs, and `describeOperation()` has no other way to
          // learn what it used to be. Rendered on every connected tab, not only one currently
          // chatting -- see this hook's own top-of-file JSDoc.
          const graphBeforeMutation = useDiagramStore.getState();
          const description = describeOperation(
            parsed.op,
            graphBeforeMutation.nodes,
            graphBeforeMutation.edges,
          );
          appendInterruptingEntry({
            id: nextTranscriptEntryId(),
            kind: "action",
            text: description,
          });
        }

        if (!isOwnPendingOperation) {
          applyRemoteOperation(parsed.op);
        }

        // See this hook's own top-of-file JSDoc ("Toast suppression for the chatting tab") for
        // why an in-flight chat turn on this tab is the signal used here, not `clientOpId`
        // reconciliation -- an `ai-chat`-origin operation never carries one.
        const suppressForChattingTab =
          parsed.origin === "ai-chat" &&
          activeChatRequestIdRef.current !== null;
        if (!suppressForChattingTab) {
          showLiveUpdateNotice(parsed.actorEmail, parsed.origin);
        }
        return;
      }

      if (isOperationRejectedMessage(parsed)) {
        if (parsed.clientOpId !== undefined) {
          pendingClientOpIdsRef.current.delete(parsed.clientOpId);
        }
        return;
      }

      if (isPresenceSnapshotMessage(parsed)) {
        const seeded: DiagramLiveSync["participants"] = {};
        for (const participant of parsed.participants) {
          seeded[participant.email] = participant;
        }
        setParticipants(seeded);
        return;
      }

      if (isPresenceJoinedMessage(parsed)) {
        setParticipants((current) => ({
          ...current,
          [parsed.email]: {
            color: parsed.color,
            displayName: parsed.displayName,
            email: parsed.email,
          },
        }));
        return;
      }

      if (isPresenceLeftMessage(parsed)) {
        const { email } = parsed;
        setParticipants((current) => {
          const { [email]: _removed, ...rest } = current;
          return rest;
        });
        // A departed identity's cursor/selection must not linger on the canvas.
        setCursors((current) => {
          const { [email]: _removed, ...rest } = current;
          return rest;
        });
        setRemoteSelections((current) => {
          const { [email]: _removed, ...rest } = current;
          return rest;
        });
        return;
      }

      if (isCursorMovedMessage(parsed)) {
        const { email, x, y } = parsed;
        setCursors((current) => ({
          ...current,
          [email]: { color: current[email]?.color ?? "#888888", x, y },
        }));
        return;
      }

      if (isSelectionChangedMessage(parsed)) {
        const { edgeId, email, nodeId } = parsed;
        setRemoteSelections((current) => ({
          ...current,
          [email]: {
            color: current[email]?.color ?? "#888888",
            edgeId,
            nodeId,
          },
        }));
        return;
      }

      if (isChatStatusMessage(parsed)) {
        appendInterruptingEntry({
          id: nextTranscriptEntryId(),
          kind: "status",
          text: parsed.message,
        });
        return;
      }

      if (isChatTokenMessage(parsed)) {
        if (stoppedRequestIdsRef.current.has(parsed.clientRequestId)) return;
        // The entry id is resolved and the ref updated *here*, synchronously, never inside the
        // `setChatTranscript` updater below. React defers an updater until render and may invoke
        // it more than once, so an updater that mutates a ref -- or that reads a ref another
        // handler mutates in the meantime -- does not observe the value its own handler saw.
        // That is precisely the bug docs/ISSUE-5.md hit; see the `chat_done` branch below.
        const isNewEntry = activeAssistantEntryIdRef.current === null;
        const entryId = isNewEntry
          ? nextTranscriptEntryId()
          : (activeAssistantEntryIdRef.current as string);
        activeAssistantEntryIdRef.current = entryId;
        streamedAnyTokenRef.current = true;
        const { text } = parsed;
        setChatTranscript((current) => {
          if (isNewEntry) {
            return [
              ...current,
              { id: entryId, kind: "assistant", stopped: false, text },
            ];
          }
          return current.map((entry) => {
            if (entry.id !== entryId) return entry;
            // Every entry whose id was captured into `activeAssistantEntryIdRef` was created
            // with `kind: "assistant"` a few lines above -- this check exists only so
            // TypeScript can narrow `entry` to the one variant with a `text` field to append
            // to, not because it can actually be false once the id itself already matched.
            /* istanbul ignore else */
            if (entry.kind === "assistant") {
              return { ...entry, text: entry.text + text };
            }
            /* istanbul ignore next -- unreachable; see the comment above. */
            return entry;
          });
        });
        return;
      }

      if (isChatToolResultMessage(parsed)) {
        appendInterruptingEntry({
          id: nextTranscriptEntryId(),
          kind: "docs_result",
          query: parsed.args.query,
          result: parsed.result,
        });
        return;
      }

      if (isChatDoneMessage(parsed)) {
        const wasStopped = stoppedRequestIdsRef.current.delete(
          parsed.clientRequestId,
        );
        // Read synchronously, before the reset below: React defers a `setChatTranscript`
        // updater until render, so an updater that reads this ref does not observe the value
        // its own handler saw. That was the docs/ISSUE-5.md duplicate-answer bug.
        const streamedAnyToken = streamedAnyTokenRef.current;
        if (!wasStopped && !streamedAnyToken) {
          // Nothing streamed at all (a genuinely empty final answer, or a turn whose whole
          // response arrived non-streamed) -- record the turn's own complete text, since no
          // bubble exists to show it.
          //
          // When tokens *did* stream there is deliberately nothing to do here. `assistantText`
          // is by construction the concatenation of exactly those tokens, and a turn may now
          // own several assistant bubbles (tool activity splits them -- see
          // `appendInterruptingEntry`), so overwriting "the" bubble with the turn's whole text
          // would duplicate every earlier bubble's prose into the last one.
          const { assistantText } = parsed;
          setChatTranscript((current) => [
            ...current,
            {
              id: nextTranscriptEntryId(),
              kind: "assistant",
              stopped: false,
              text: assistantText,
            },
          ]);
        }
        if (activeChatRequestIdRef.current === parsed.clientRequestId) {
          activeChatRequestIdRef.current = null;
          activeAssistantEntryIdRef.current = null;
          streamedAnyTokenRef.current = false;
          setChatInFlight(false);
        }
        return;
      }

      if (isChatErrorMessage(parsed)) {
        const wasStopped = stoppedRequestIdsRef.current.delete(
          parsed.clientRequestId,
        );
        if (!wasStopped) {
          setChatTranscript((current) => [
            ...current,
            {
              id: nextTranscriptEntryId(),
              kind: "error",
              text: parsed.message,
            },
          ]);
        }
        if (activeChatRequestIdRef.current === parsed.clientRequestId) {
          activeChatRequestIdRef.current = null;
          activeAssistantEntryIdRef.current = null;
          streamedAnyTokenRef.current = false;
          setChatInFlight(false);
        }
        return;
      }

      if (isDiagramRenamedMessage(parsed)) {
        applyRemoteRename(parsed.title, parsed.description ?? "");
        return;
      }

      // Any other/genuinely unrecognized type is silently ignored, matching this channel's
      // existing precedent.
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClosedOrErrored);
    socket.addEventListener("error", onClosedOrErrored);
    socket.addEventListener("message", onMessage);

    return () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClosedOrErrored);
      socket.removeEventListener("error", onClosedOrErrored);
      socket.removeEventListener("message", onMessage);
      socket.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [
    diagramId,
    enabled,
    applyRemoteGraphSnapshot,
    applyRemoteOperation,
    showLiveUpdateNotice,
    applyRemoteRename,
  ]);

  const sendOperation = useCallback(
    (op: GraphOperation, clientOpId: string): boolean => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      pendingClientOpIdsRef.current.add(clientOpId);
      socket.send(JSON.stringify({ clientOpId, op, type: "operation" }));
      return true;
    },
    [],
  );

  const sendCursor = useCallback((x: number, y: number) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastCursorSentAtRef.current < CURSOR_THROTTLE_MS) return;
    lastCursorSentAtRef.current = now;
    socket.send(JSON.stringify({ type: "cursor_moved", x, y }));
  }, []);

  const sendSelectionChange = useCallback(
    (nodeId: string | null, edgeId: string | null) => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({ edgeId, nodeId, type: "selection_changed" }),
      );
    },
    [],
  );

  const sendChatMessage = useCallback(
    (text: string, displayText?: string): string | false => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      const clientRequestId = crypto.randomUUID();
      activeChatRequestIdRef.current = clientRequestId;
      activeAssistantEntryIdRef.current = null;
      streamedAnyTokenRef.current = false;
      setChatInFlight(true);
      setChatTranscript((current) => [
        ...current,
        {
          id: nextTranscriptEntryId(),
          kind: "user",
          text: displayText ?? text,
        },
      ]);
      socket.send(
        JSON.stringify({ clientRequestId, text, type: "chat_message" }),
      );
      return clientRequestId;
    },
    [],
  );

  const stopChatTurn = useCallback(() => {
    const clientRequestId = activeChatRequestIdRef.current;
    if (clientRequestId === null) return;

    stoppedRequestIdsRef.current.add(clientRequestId);
    const assistantEntryId = activeAssistantEntryIdRef.current;
    if (assistantEntryId !== null) {
      setChatTranscript((current) =>
        current.map((entry) => {
          if (entry.id !== assistantEntryId) return entry;
          // See the symmetric comment in `onMessage`'s `chat_token` branch above -- this
          // check exists only for TypeScript's benefit.
          /* istanbul ignore else */
          if (entry.kind === "assistant") {
            return { ...entry, stopped: true };
          }
          /* istanbul ignore next -- unreachable; see the comment above. */
          return entry;
        }),
      );
    }

    // "Stop watching" only -- the turn keeps running server-side; see this hook's own
    // `DiagramLiveSync.stopChatTurn` JSDoc.
    activeChatRequestIdRef.current = null;
    activeAssistantEntryIdRef.current = null;
    streamedAnyTokenRef.current = false;
    setChatInFlight(false);
  }, []);

  const clearChatTranscript = useCallback(() => {
    setChatTranscript([]);
    // The in-flight turn's future tokens (if any) start a fresh assistant entry in the now-empty
    // transcript rather than trying to append onto an entry id this cleared array no longer has.
    activeAssistantEntryIdRef.current = null;
  }, []);

  return {
    chatInFlight,
    chatTranscript,
    clearChatTranscript,
    connected,
    cursors,
    participants,
    remoteSelections,
    sendChatMessage,
    sendCursor,
    sendOperation,
    sendSelectionChange,
    stopChatTurn,
  };
}
