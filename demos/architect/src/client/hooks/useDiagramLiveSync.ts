import { useEffect } from "react";
import { useDiagramStore } from "../stores/diagramStore";

/** Shape of the one message type `../../worker/diagram-session/diagram-session.ts` ever sends. */
interface GraphUpdatedMessage {
  type: "graph_updated";
  graphData: string;
  updatedAt: string;
}

/** Narrow an arbitrary decoded WebSocket frame down to {@link GraphUpdatedMessage}. */
function isGraphUpdatedMessage(value: unknown): value is GraphUpdatedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "graph_updated" &&
    typeof (value as { graphData?: unknown }).graphData === "string" &&
    typeof (value as { updatedAt?: unknown }).updatedAt === "string"
  );
}

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
 * Open a read-only WebSocket to the diagram's `DiagramSession` Durable Object
 * (`../../worker/diagram-session/diagram-session.ts`, docs/09B-ARCHITECT-MCP.md's Live Sync
 * Architecture) for as long as this hook stays mounted, applying every `graph_updated` push to
 * the Zustand store via `applyRemoteGraphUpdate()` -- which itself discards a push that is not
 * actually newer than what the store already has. This hook never sends anything over the
 * socket: the channel is strictly server-to-client push, and the browser's own edits keep using
 * the existing debounced `PUT /api/diagrams/:id/graph` autosave path unchanged.
 *
 * Unlike `demos/chat`'s room store, this hook does not reconnect after a drop -- this channel is
 * a live-editing convenience for a single owner's own already-open tab, not the authoritative
 * source of the diagram's data (D1 always is), so a dropped connection just means a later manual
 * refresh picks up any change missed in between, not data loss.
 *
 * @param diagramId Diagram id to subscribe to, or `null` before one has loaded.
 * @param enabled Whether to actually open the connection. Callers disable this for the
 * read-only, anonymous share viewer (`../views/ShareView.tsx`), which authenticates via a share
 * token rather than a Cloudflare Access identity and could never pass this route's owner check.
 */
export function useDiagramLiveSync(
  diagramId: string | null,
  enabled: boolean,
): void {
  const applyRemoteGraphUpdate = useDiagramStore(
    (state) => state.applyRemoteGraphUpdate,
  );

  useEffect(() => {
    if (!enabled || diagramId === null) return;

    const socket = new WebSocket(liveSyncUrl(diagramId));
    const onMessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (isGraphUpdatedMessage(parsed)) {
        applyRemoteGraphUpdate(parsed.graphData, parsed.updatedAt);
      }
    };
    socket.addEventListener("message", onMessage);

    return () => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    };
  }, [diagramId, enabled, applyRemoteGraphUpdate]);
}
