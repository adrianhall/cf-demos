/**
 * Browser connection manager for one diagram's live collaboration WebSocket
 * (`/api/diagrams/:id/ws` — `../../worker/routes/diagrams.ts`).
 *
 * This is not a Vue composable in the reactive-`ref` sense — it holds connection state (the
 * live `WebSocket`, reconnect timer, and backoff delay) in plain closures rather than reactive
 * refs, exactly matching `demos/chat/src/client/stores/room.ts`'s own reconnect/backoff
 * machinery — because it is driven entirely from `../stores/diagram-document.ts`'s Pinia actions
 * rather than a component's `setup()` scope. It never touches Vue reactivity itself; the calling
 * store owns translating each `ServerFrame` into reactive state. It is named and exported this
 * way (rather than inlined directly into the store) so its connect/reconnect/backoff logic is
 * independently testable and reusable.
 */
import type { ClientFrame, ServerFrame } from "../../collaboration-protocol";
import {
  MALFORMED_FRAME_CLOSE_CODE,
  MISSING_TRUSTED_IDENTITY_CLOSE_CODE,
} from "../../collaboration-protocol";

/** Lifecycle of one diagram's live collaboration connection. */
export type DiagramSocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** Callbacks a caller supplies to react to connection lifecycle and inbound frames. */
export interface DiagramSocketCallbacks {
  /** Called once for every successfully decoded `ServerFrame`. */
  onFrame(frame: ServerFrame): void;
  /** Called whenever {@link DiagramSocketStatus} changes. */
  onStatusChange(status: DiagramSocketStatus): void;
}

/** Handle returned by {@link useDiagramSocket} for sending frames and disconnecting deliberately. */
export interface DiagramSocketHandle {
  /** Send one frame over the live connection. A no-op while not currently connected. */
  send(frame: ClientFrame): void;
  /** Close the connection deliberately (for example, navigating away) without reconnecting. */
  disconnect(): void;
}

/** Initial delay before the first reconnect attempt after an unexpected drop. */
const INITIAL_RECONNECT_DELAY_MS = 1_000;
/** Upper bound for the exponential reconnect backoff. */
const MAX_RECONNECT_DELAY_MS = 10_000;

/** Build the same-origin WebSocket URL for a diagram's upgrade route. */
function diagramSocketUrl(diagramId: string): URL {
  const url = new URL(
    `/api/diagrams/${encodeURIComponent(diagramId)}/ws`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * Open (and, on an unexpected drop, transparently reconnect) a live WebSocket connection to one
 * diagram's `DiagramRoom`.
 *
 * A transient drop reconnects with exponential backoff, relying on the room's replayed `sync`
 * frame to recover authoritative state on reconnect. A close carrying
 * `MALFORMED_FRAME_CLOSE_CODE` or `MISSING_TRUSTED_IDENTITY_CLOSE_CODE` indicates a client- or
 * server-side protocol bug rather than a transient network drop, so it is reported as `"error"`
 * instead of silently retried into the same failure. Calling `disconnect()` never reconnects.
 *
 * @param diagramId Diagram whose room to connect to.
 * @param callbacks Frame and status-change handlers.
 * @returns A handle for sending frames and disconnecting deliberately.
 */
export function useDiagramSocket(
  diagramId: string,
  callbacks: DiagramSocketCallbacks,
): DiagramSocketHandle {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let closingIntentionally = false;

  /** Cancel a pending scheduled reconnect, if one is queued. */
  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Open a new WebSocket to `diagramId` and wire its event handlers. */
  function openSocket(): void {
    callbacks.onStatusChange("connecting");
    const ws = new WebSocket(diagramSocketUrl(diagramId));
    socket = ws;

    ws.addEventListener("open", () => {
      if (socket !== ws) {
        return;
      }
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      callbacks.onStatusChange("connected");
    });

    ws.addEventListener("message", (event) => {
      if (socket !== ws) {
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      callbacks.onFrame(frame);
    });

    ws.addEventListener("close", (event) => {
      if (socket !== ws) {
        // Superseded by a newer connection; this socket's close is already handled by whichever
        // code replaced it.
        return;
      }
      socket = null;
      if (closingIntentionally) {
        closingIntentionally = false;
        callbacks.onStatusChange("idle");
        return;
      }
      if (
        event.code === MALFORMED_FRAME_CLOSE_CODE ||
        event.code === MISSING_TRUSTED_IDENTITY_CLOSE_CODE
      ) {
        callbacks.onStatusChange("error");
        return;
      }
      callbacks.onStatusChange("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    });
  }

  openSocket();

  return {
    disconnect(): void {
      clearReconnectTimer();
      if (socket !== null) {
        closingIntentionally = true;
        socket.close();
      } else {
        callbacks.onStatusChange("idle");
      }
    },
    send(frame: ClientFrame): void {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
  };
}
