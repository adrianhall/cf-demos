import { DurableObject } from "cloudflare:workers";

/**
 * `DiagramSession` is docs/09B-ARCHITECT-MCP.md's live-sync fan-out point -- one instance per
 * diagram id (`env.DIAGRAM_SESSIONS.getByName(diagramId)`), holding every browser WebSocket
 * currently open on that diagram and pushing the fresh graph to all of them the instant a remote
 * MCP tool call changes it (see `../mcp/tools.ts`'s `applyGraphMutation()`).
 *
 * This object holds no durable data of its own: D1's `diagrams` table remains the single source
 * of truth for a diagram's graph, so its only real state is the hibernatable WebSocket set
 * `ctx.getWebSockets()` already tracks for free. `wrangler.jsonc.tpl`'s `new_sqlite_classes`
 * migration is still required by Wrangler for any Durable Object class, even though this one
 * persists nothing meaningful to it.
 *
 * This channel is strictly server-to-client push (docs/09B-ARCHITECT-MCP.md's Live Sync
 * Architecture): it never accepts writes from the browser side of the socket. The browser's own
 * edits keep using the existing debounced `PUT /api/diagrams/:id/graph` autosave path.
 */
export class DiagramSession extends DurableObject<Env> {
  /**
   * Accept a WebSocket upgrade already authorized by the Worker. `../routes/diagrams.ts`'s
   * `GET /api/diagrams/:id/live` route verifies the caller owns this diagram
   * (`DiagramRepository.findOwned()`) *before* forwarding the request here -- this object
   * performs no authorization of its own, matching this repository's usual pattern of
   * authorization living at the Worker/API boundary, not inside the Durable Object.
   *
   * Uses the WebSocket Hibernation API (`ctx.acceptWebSocket()`, not `server.accept()`) so an
   * idle open editor tab does not keep billing this object while nothing is happening.
   *
   * @param request Upgrade request forwarded by the Worker.
   * @returns A `101` WebSocket upgrade response, or a plain `400` for a non-upgrade request.
   */
  fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request.", {
        status: 400,
      });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Push the diagram's fresh graph to every currently-accepted WebSocket. Called by the Worker
   * (never the browser) as an RPC method, immediately after a graph-mutating MCP tool call
   * persists to D1.
   *
   * @param graphData Canonical, already-persisted JSON string (`../diagrams/types.ts`'s
   * `GraphData`).
   * @param updatedAt New `updated_at` timestamp, so a receiving client can discard a push older
   * than its own most recent state (docs/09B-ARCHITECT-MCP.md's Concurrency Model).
   */
  notifyGraphUpdated(graphData: string, updatedAt: string): void {
    const message = JSON.stringify({
      graphData,
      type: "graph_updated",
      updatedAt,
    });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }

  /**
   * This channel never accepts client-sent frames (see this class's own JSDoc); any frame a
   * browser sends anyway is silently ignored rather than tearing down the connection over it.
   */
  webSocketMessage(): void {}

  /** No per-socket state to clean up: hibernation already discards a closed socket's state for
   * free, and this object's only "state" is `ctx.getWebSockets()` itself. */
  webSocketClose(): void {}

  /** No-op, for the same reason as {@link webSocketClose}. */
  webSocketError(): void {}
}
