import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphOperation } from "../../graph-mutations";
import { useDiagramStore } from "../stores/diagramStore";

/** A `graph_snapshot` frame -- sent once, immediately on connect, and again after a whole-graph
 * replace (`../../worker/diagram-session/diagram-session.ts`'s `applyWholeGraphReplace()`). */
interface GraphSnapshotMessage {
  type: "graph_snapshot";
  graphData: string;
  sequence: number;
}

/** An `operation_applied` frame -- broadcast to every connection, including the originator. */
interface OperationAppliedMessage {
  type: "operation_applied";
  clientOpId?: string;
  actorEmail: string;
  origin: "human" | "agent";
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
      (value as { origin?: unknown }).origin === "agent") &&
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
 * (`../../graph-mutations.ts`) and the toast is surfaced.
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
  const socketRef = useRef<WebSocket | null>(null);
  // Ids this tab has itself sent and not yet reconciled via an `operation_applied`/
  // `operation_rejected` echo. A plain ref, not store state: purely local socket-reconciliation
  // bookkeeping with no reason to be shared app state or trigger a re-render on its own.
  const pendingClientOpIdsRef = useRef<Set<string>>(new Set());
  const highestSequenceRef = useRef(0);
  // Timestamp (`Date.now()`) of the most recently *sent* `cursor_moved` frame -- the minimum-
  // interval gate behind `sendCursor()`'s ~15/sec client-side throttle.
  const lastCursorSentAtRef = useRef(0);

  const applyRemoteGraphSnapshot = useDiagramStore(
    (state) => state.applyRemoteGraphSnapshot,
  );
  const applyRemoteOperation = useDiagramStore(
    (state) => state.applyRemoteOperation,
  );
  const showLiveUpdateNotice = useDiagramStore(
    (state) => state.showLiveUpdateNotice,
  );

  useEffect(() => {
    if (!enabled || diagramId === null) {
      setConnected(false);
      return;
    }

    highestSequenceRef.current = 0;
    pendingClientOpIdsRef.current.clear();
    lastCursorSentAtRef.current = 0;
    setParticipants({});
    setCursors({});
    setRemoteSelections({});

    const socket = new WebSocket(liveSyncUrl(diagramId));
    socketRef.current = socket;

    const onOpen = () => setConnected(true);
    const onClosedOrErrored = () => setConnected(false);

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

        if (!isOwnPendingOperation) {
          applyRemoteOperation(parsed.op);
        }
        showLiveUpdateNotice(parsed.actorEmail, parsed.origin);
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

  return {
    connected,
    cursors,
    participants,
    remoteSelections,
    sendCursor,
    sendOperation,
    sendSelectionChange,
  };
}
