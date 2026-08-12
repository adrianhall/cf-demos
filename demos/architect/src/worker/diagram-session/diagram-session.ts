import { DurableObject } from "cloudflare:workers";
import {
  applyGraphOperation,
  type GraphOperation,
} from "../../graph-mutations";
import {
  runDiagramChatTurn,
  type ChatAiBinding,
  type ChatMessage,
} from "../ai/chat-engine";
import { DiagramRepository } from "../diagrams/repository";
import type { GraphData } from "../diagrams/types";
import { colorForEmail } from "./presence-color";

/** One connected browser tab's per-connection identity, persisted via
 * `WebSocket.serializeAttachment()` so it survives hibernation (unlike a plain class field --
 * see this class's own JSDoc). */
interface ConnectionAttachment {
  /** Verified Cloudflare Access identity email for this connection, forwarded by
   * `../routes/diagrams.ts`'s `GET /:id/live` route as the `identity` query parameter. */
  email: string;
  /** This identity's stable-for-the-session presence color (`./presence-color.ts`), computed
   * once at `fetch()`-time and reused for every `presence_snapshot`/`presence_joined`/
   * `cursor_moved`/`selection_changed` frame this connection's identity ever appears in --
   * computed here rather than by the client, so the client only ever renders a color string it
   * is given (docs/09C-COLLABORATIVE-EDITING.md's Phase 19 Decision B). */
  color: string;
}

/** A parsed `{ type: "operation", clientOpId, op }` client frame. */
interface OperationFrame {
  type: "operation";
  /** Client-generated id the sender uses to reconcile its own optimistic local edit against
   * this operation's `operation_applied` echo. Optional so a malformed frame missing it does
   * not crash parsing -- `applyOperation()` itself treats a `undefined` value as "no client to
   * reconcile with," matching an MCP-originated call, which has no `clientOpId` at all. */
  clientOpId?: string;
  op: GraphOperation;
}

/** A parsed `{ type: "cursor_moved", x, y }` client frame -- relayed verbatim (with `email`
 * added) to every other open connection, never persisted (docs/09C-COLLABORATIVE-EDITING.md's
 * Message Protocol). */
interface CursorMovedFrame {
  type: "cursor_moved";
  x: number;
  y: number;
}

/** A parsed `{ type: "selection_changed", nodeId?, edgeId? }` client frame -- both fields
 * optional/nullable, `null`/absent meaning "deselected." Relayed verbatim (with `email` added)
 * to every other open connection, never persisted. */
interface SelectionChangedFrame {
  type: "selection_changed";
  nodeId?: string | null;
  edgeId?: string | null;
}

/**
 * A parsed `{ type: "chat_message", clientRequestId, text }` client frame
 * (docs/09D-ARCHITECT-AICHAT.md's Message Protocol) -- runs one turn of
 * `../ai/chat-engine.ts`'s `runDiagramChatTurn()` against this connection's own ephemeral
 * conversation history. See {@link handleChatMessage}'s own JSDoc for the full set of outbound
 * frames one `chat_message` can produce (`chat_status`/`chat_token`/`chat_tool_result`/
 * `chat_done`/`chat_error`/`diagram_renamed`) -- this document's Phase 24 client implements the
 * other side of that contract against the shapes documented there, so keep them in sync with
 * this file, not a separate protocol file (see this class's own JSDoc for why).
 */
interface ChatMessageFrame {
  type: "chat_message";
  /** Client-generated id this connection uses to correlate every outbound `chat_status`/
   * `chat_token`/`chat_tool_result`/`chat_done`/`chat_error` frame this turn produces back to
   * the specific `chat_message` that triggered it. */
  clientRequestId: string;
  /** The user's new message text for this turn. */
  text: string;
}

/** Narrow an arbitrary decoded WebSocket frame down to {@link OperationFrame}. */
function isOperationFrame(value: unknown): value is OperationFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "operation" &&
    typeof (value as { op?: unknown }).op === "object" &&
    (value as { op?: unknown }).op !== null
  );
}

/** Narrow an arbitrary decoded WebSocket frame down to {@link CursorMovedFrame}, tolerating a
 * malformed `x`/`y` (non-number) the same way {@link isOperationFrame} tolerates a malformed
 * `op` -- the frame is simply ignored rather than crashing this connection. */
function isCursorMovedFrame(value: unknown): value is CursorMovedFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "cursor_moved" &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  );
}

/** Narrow an arbitrary decoded WebSocket frame down to {@link SelectionChangedFrame}. Each of
 * `nodeId`/`edgeId` may be absent, `null` (both mean "no selection of that kind"), or a
 * `string` -- any other type on either field makes the whole frame unrecognized. */
function isSelectionChangedFrame(
  value: unknown,
): value is SelectionChangedFrame {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { type?: unknown }).type !== "selection_changed") {
    return false;
  }
  const nodeId = (value as { nodeId?: unknown }).nodeId;
  const edgeId = (value as { edgeId?: unknown }).edgeId;
  const isValidField = (field: unknown) =>
    field === undefined || field === null || typeof field === "string";
  return isValidField(nodeId) && isValidField(edgeId);
}

/** Narrow an arbitrary decoded WebSocket frame down to {@link ChatMessageFrame}. */
function isChatMessageFrame(value: unknown): value is ChatMessageFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "chat_message" &&
    typeof (value as { clientRequestId?: unknown }).clientRequestId ===
      "string" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * `DiagramSession` is docs/09C-COLLABORATIVE-EDITING.md's bidirectional live-sync coordination
 * point -- one instance per diagram id (`env.DIAGRAM_SESSIONS.getByName(diagramId)`), holding
 * every browser WebSocket currently open on that diagram and the single in-process code path
 * every graph mutation goes through, whether it originates from a human's own WebSocket message
 * (`webSocketMessage()`), from a 9B MCP tool call (`../mcp/tools.ts`, via `applyOperation()`/
 * `applyWholeGraphReplace()` RPC calls), or -- as of docs/09D-ARCHITECT-AICHAT.md -- from an AI
 * chat turn's own tool calls (`origin: "ai-chat"`, via `handleChatMessage()`/`../ai/chat-engine.ts`).
 *
 * This object holds no *durable* data of its own -- D1's `diagrams` table remains the diagram's
 * one and only durable copy, unconditionally (docs/09C-COLLABORATIVE-EDITING.md's "Why D1 Stays
 * The Only Copy"). What it does hold is small, disposable, in-process state: an in-memory
 * working copy of the graph (`this.graph`, a read-through cache hydrated from D1 on first use),
 * the diagram's current `title`/`description` (also read-through cached, kept in sync with
 * every successful `rename_diagram` tool call), an in-memory operation counter
 * (`this.sequence`), a single per-object write chain (`this.writeChain`) that serializes every
 * persist-to-D1 call so an older, slower write can never clobber a newer one, and -- new in
 * docs/09D-ARCHITECT-AICHAT.md -- each open connection's own ephemeral AI chat conversation
 * history (`this.chatHistories`). `wrangler.jsonc.tpl`'s `new_sqlite_classes` migration is still
 * required by Wrangler for any Durable Object class, even though this one persists nothing
 * meaningful to `ctx.storage` -- this class never calls `ctx.storage.sql` at all.
 *
 * Every public method below hydrates (`ensureHydrated()`) before doing anything else, since an
 * MCP tool call can reach this object via plain RPC with no `fetch()` WebSocket upgrade ever
 * having run first.
 *
 * **AI chat message protocol** (docs/09D-ARCHITECT-AICHAT.md's Message Protocol). Like every
 * other message this object's WebSocket protocol carries, these frame shapes are defined as
 * private inline interfaces + type-guard functions directly in this file (see
 * {@link ChatMessageFrame}/{@link isChatMessageFrame} above) rather than a separate shared
 * protocol file -- this codebase has never had one (`operation`/`cursor_moved`/
 * `selection_changed` all follow this same pattern already), and the client-side implementation
 * of this same contract (`docs/09D-ARCHITECT-AICHAT.md`'s Phase 24, not part of this phase)
 * duplicates it independently in `src/client/hooks/useDiagramLiveSync.ts`, exactly like it
 * already duplicates 9C's own frame shapes. The full contract, documented here so Phase 24 can
 * implement the client side against it without re-deriving it from this file's implementation:
 *
 * - `{ type: "chat_message", clientRequestId, text }` (client -> this object): see
 *   {@link ChatMessageFrame}. Routed to {@link handleChatMessage}.
 * - `{ type: "chat_status", clientRequestId, message }` (this object -> originating connection
 *   only): progress narration ("Adding node…", "Checking Cloudflare docs…").
 * - `{ type: "chat_token", clientRequestId, text }` (originating connection only): one streamed
 *   chunk of the turn's final natural-language answer.
 * - `{ type: "chat_tool_result", clientRequestId, tool: "search_cloudflare_documentation", args:
 *   { query }, result }` (originating connection only): `result` is either
 *   `DocumentationResult[]` (`../ai/docs-client.ts`) on success or `{ message }` on the
 *   non-fatal "documentation search is currently unavailable" fallback. Sent only for this one
 *   tool -- a graph-mutating tool's effect already arrives as an ordinary `operation_applied`
 *   broadcast (see below), which needs no frame of its own.
 * - `{ type: "chat_done", clientRequestId, assistantText }` (originating connection only): the
 *   turn's complete final answer.
 * - `{ type: "chat_error", clientRequestId, message }` (originating connection only): sent
 *   instead of `chat_done` when the turn threw; never crashes this connection or this object.
 * - `{ type: "diagram_renamed", title, description }` (**broadcast** to every connection): a
 *   `rename_diagram` tool call changed diagram metadata every viewer's toolbar/tab title should
 *   reflect.
 * - Every graph-mutating tool call's effect is an ordinary `operation_applied` broadcast (9C,
 *   unchanged shape) with `origin: "ai-chat"` -- the entire mechanism by which a collaborator
 *   who is not chatting still sees the assistant's edits live; see {@link applyOperation}'s own
 *   JSDoc.
 */
export class DiagramSession extends DurableObject<Env> {
  /** In-memory working copy of the diagram's graph, `null` until {@link ensureHydrated} first
   * loads it from D1. Mutated synchronously (no `await` between reading and replacing it) by
   * every operation -- see this class's own JSDoc and docs/09C-COLLABORATIVE-EDITING.md's "Why
   * D1 Stays The Only Copy" for why that single property is what makes concurrent operations
   * safe. */
  private graph: GraphData | null = null;
  /** The diagram's owner email, read once at hydration time -- needed for
   * `DiagramRepository.saveGraphData()`'s owner-scoped `WHERE` clause, which scopes by the
   * diagram's *owner*, not by whichever identity actually triggered a given operation. */
  private ownerEmail: string | null = null;
  /** The diagram's current title, read at hydration time and kept in sync with every successful
   * `rename_diagram` AI chat tool call (docs/09D-ARCHITECT-AICHAT.md) -- read directly by
   * {@link handleChatMessage} so `../ai/chat-engine.ts`'s system prompt always reflects the
   * *current* title, not a value captured once at connect time. */
  private title: string | null = null;
  /** The diagram's current description, symmetric to {@link title}. `null` means "unset,"
   * exactly like the D1 column itself. */
  private description: string | null = null;
  /** In-memory operation counter, incremented once per applied operation. Not persisted --
   * resets to `0` whenever this object rehydrates, which is harmless (see
   * docs/09C-COLLABORATIVE-EDITING.md's Concurrency Model: a reconnecting client always starts
   * from a fresh `graph_snapshot`, never a replayed sequence). */
  private sequence = 0;
  /** The single per-object write chain every persist-to-D1 call joins, so writes land in D1 in
   * the same order they were requested, each reading `this.graph` fresh at the moment it
   * actually runs rather than a value captured when it was enqueued. */
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Whether {@link ensureHydrated} has already loaded `this.graph`/`this.ownerEmail`/
   * `this.title`/`this.description` from D1 since this object's last cold start or eviction. */
  private hydrated = false;
  /**
   * Each open connection's own ephemeral AI chat conversation history
   * (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution), keyed by the connection's own
   * `WebSocket` object. **Deliberately a plain class field, not a `serializeAttachment()`-backed
   * addition to {@link ConnectionAttachment}** -- the two real options considered were (a)
   * folding `messages` into `ConnectionAttachment` (literally "mirroring 9C's own per-connection
   * ephemeral state," since the display color already lives there), re-serializing after every
   * turn, or (b) this plain in-memory `Map`. (a) would need active truncation logic to stay
   * under `serializeAttachment()`'s confirmed 16,384-byte limit
   * (https://developers.cloudflare.com/durable-objects/best-practices/websockets/) once a long
   * conversation's transcript grows past it -- real complexity for a value
   * docs/09D-ARCHITECT-AICHAT.md's own Non-Goals section already says is allowed to be lost
   * ("Reloading the editor starts a fresh conversation... discarded on hibernation/eviction and
   * never written to D1"). (b) has no size limit and is simpler, at the cost of *also* losing
   * history on hibernation specifically (not just on disconnect/reload) -- a strictly narrower
   * trade-off than what the design doc already explicitly accepts, so (b) is what this class
   * implements. A connection with no entry here yet (a brand new connection, or one whose entry
   * was lost to hibernation) simply starts its next chat turn with empty history -- a fresh
   * conversation, exactly as expected.
   */
  private readonly chatHistories = new Map<WebSocket, ChatMessage[]>();

  /**
   * Load this diagram's graph and owner from D1 into memory, exactly once per activation. Every
   * public method below calls this first. Guarded by `blockConcurrencyWhile()` -- the correct
   * tool for one-time initialization per the `durable-objects` skill -- so no operation is ever
   * applied against a not-yet-hydrated graph. `blockConcurrencyWhile()` itself blocks every
   * other event (including a second concurrent caller's own `ensureHydrated()` call) from
   * running at all until this callback resolves, so a second caller's own outer `if
   * (this.hydrated) return` above already sees `true` by the time it gets to run -- no separate
   * re-check inside the callback is reachable or needed.
   *
   * Uses `this.ctx.id.name` to know its own diagram id -- populated automatically by the
   * Workers runtime for any Durable Object accessed via `getByName()`/`idFromName()` (confirmed
   * against the current, March 2026 changelog entry; see this repository's `docs/DECISIONS.md`
   * for the sanity-check test that verified this holds in this repo's pinned Wrangler runtime)
   * -- exactly how every real caller already obtains this object's stub, so no method below
   * needs its own explicit `diagramId` parameter.
   *
   * @throws {Error} When `this.ctx.id.name` is unexpectedly unset (this object was reached
   * through some path other than `getByName()`/`idFromName()`), or when the diagram no longer
   * exists in D1 (deleted in the narrow window between the Worker's own authorization check and
   * this call) -- a genuine edge case that does not need more elaborate handling than a plain,
   * clearly-worded error.
   */
  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const diagramId = this.ctx.id.name;
      if (diagramId === undefined) {
        throw new Error(
          "DiagramSession must be accessed via getByName()/idFromName() so ctx.id.name is set.",
        );
      }

      const diagram = await new DiagramRepository(this.env.DB).findAny(
        diagramId,
      );
      if (diagram === null) {
        throw new Error(`Diagram "${diagramId}" no longer exists.`);
      }

      this.graph = JSON.parse(diagram.graphData) as GraphData;
      this.ownerEmail = diagram.ownerEmail;
      this.title = diagram.title;
      this.description = diagram.description;
      this.hydrated = true;
    });
  }

  /**
   * Persist the current `this.graph` to D1, joining this object's write chain so writes land in
   * the same order they were requested regardless of how long any individual write takes.
   *
   * @returns The new `updated_at` timestamp `saveGraphData()` reports, or a best-effort current
   * timestamp in the rare case the row no longer exists to update (the diagram was deleted out
   * from under an already-hydrated session) -- not itself persisted, just a plausible value for
   * this one response.
   */
  private persistGraph(): Promise<string> {
    const writePromise = this.writeChain.then(async () => {
      const updatedAt = await new DiagramRepository(this.env.DB).saveGraphData(
        this.ctx.id.name as string,
        this.ownerEmail as string,
        JSON.stringify(this.graph),
      );
      return updatedAt ?? new Date().toISOString();
    });
    this.writeChain = writePromise;
    return writePromise;
  }

  /**
   * Broadcast a JSON message to every currently open WebSocket connection on this diagram.
   *
   * @param message Already-`JSON.stringify()`-encoded frame to send.
   * @param exclude When set, this exact connection is skipped -- used for `presence_joined`
   * (a newly connecting identity does not need to be told about its own join) and the
   * `cursor_moved`/`selection_changed` relay (a client never needs its own cursor/selection
   * echoed back, docs/09C-COLLABORATIVE-EDITING.md's Phase 19). Every other broadcast
   * (`operation_applied`, `graph_snapshot`) omits this so it reaches every connection,
   * including the originator.
   */
  private broadcast(message: string, exclude?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }

  /**
   * Apply one discrete graph mutation -- the one code path every graph mutation goes through,
   * whether it originated from a human's WebSocket message (`webSocketMessage()`) or a 9B MCP
   * tool call (`../mcp/tools.ts`). Mutates `this.graph` synchronously (no `await` between
   * reading and replacing it -- see this class's own JSDoc), increments `this.sequence`,
   * broadcasts `operation_applied` to every open connection (including the originator, an
   * echo/ack it uses to reconcile `clientOpId` against its own optimistic local state), then
   * awaits this operation's turn in the write chain to persist before returning.
   *
   * If `op` targets a node/edge id that no longer exists, the underlying
   * `../../graph-mutations.ts` function throws `notFound()` *before* `this.graph` is ever
   * reassigned or anything is broadcast -- that exception propagates to this method's own
   * caller unchanged. Turning that specific error into a non-throwing `operation_rejected`
   * message sent only to the originating connection is `webSocketMessage()`'s job, not this
   * method's: a direct RPC caller (the MCP tool path) needs a normal thrown error, matching
   * every other MCP tool's existing `notFound()` behavior, so this method stays the single,
   * honest, throwing mutation primitive both callers share.
   *
   * @param op The operation to apply.
   * @param actorEmail Verified identity that performed this operation (a human's own identity,
   * or the identity an MCP tool call or AI chat tool call is authenticated as).
   * @param origin `"human"` for a WebSocket-originated edit, `"agent"` for an MCP tool call,
   * `"ai-chat"` for a tool call made during an AI chat turn (docs/09D-ARCHITECT-AICHAT.md) --
   * lets a receiving client's UI distinguish its owner's own live edits from an agent's or the
   * assistant's, even though an MCP call or AI chat turn both authenticate as that same owner
   * identity (docs/09C-COLLABORATIVE-EDITING.md's Interplay With Demo 9B).
   * @param clientOpId The originating client's own id for this operation, echoed back in the
   * broadcast so that client can reconcile it against its optimistic local state. `undefined`
   * for an MCP- or AI-chat-originated call, neither of which has a client-side pending
   * operation to reconcile.
   * @returns The graph's fresh JSON string, the new persisted `updatedAt`, and this operation's
   * `sequence` number.
   * @throws {ProblemDetailsError} `notFound()` when `op` targets a node/edge id that does not
   * exist in the current graph.
   */
  async applyOperation(
    op: GraphOperation,
    actorEmail: string,
    origin: "human" | "agent" | "ai-chat",
    clientOpId?: string,
  ): Promise<{ graphData: string; updatedAt: string; sequence: number }> {
    await this.ensureHydrated();

    this.graph = applyGraphOperation(this.graph as GraphData, op);
    this.sequence += 1;
    const sequence = this.sequence;

    this.broadcast(
      JSON.stringify({
        actorEmail,
        clientOpId,
        op,
        origin,
        sequence,
        type: "operation_applied",
      }),
    );

    const updatedAt = await this.persistGraph();
    return { graphData: JSON.stringify(this.graph), sequence, updatedAt };
  }

  /**
   * Replace the entire graph at once -- the one legitimate whole-graph write path
   * (docs/09C-COLLABORATIVE-EDITING.md's RPC Surface): 9B's `auto_layout_diagram` MCP tool
   * (which genuinely repositions every node at once) and `PUT /api/diagrams/:id/graph`'s
   * resilience-fallback role for a client whose live WebSocket has not yet (re)connected.
   *
   * Broadcasts a `graph_snapshot` message -- not `operation_applied` -- since a whole-graph
   * replace is not itself one of the six discrete operation kinds the granular protocol has a
   * shape for; this reuses the exact same message shape already sent once, immediately, to
   * every new connection (`fetch()`).
   *
   * @param graphData Already-canonicalized JSON string to replace `this.graph` with.
   * @param _actorEmail Verified identity that performed this replace. Accepted for parity with
   * `applyOperation()`'s signature (docs/09C-COLLABORATIVE-EDITING.md's RPC Surface) but not
   * itself part of the `graph_snapshot` broadcast payload, which -- unlike `operation_applied`
   * -- carries no actor attribution at all.
   * @param _origin `"human"`, `"agent"`, or `"ai-chat"`, for the same parity reason as
   * `_actorEmail` -- this method is not currently called with `"ai-chat"` (docs/09D-ARCHITECT-AICHAT.md's
   * chat turns only ever call {@link applyOperation}), but the parameter type is widened here
   * too for consistency with it.
   * @returns The new persisted `updatedAt` and this replace's `sequence` number.
   */
  async applyWholeGraphReplace(
    graphData: string,
    _actorEmail: string,
    _origin: "human" | "agent" | "ai-chat",
  ): Promise<{ updatedAt: string; sequence: number }> {
    await this.ensureHydrated();

    this.graph = JSON.parse(graphData) as GraphData;
    this.sequence += 1;
    const sequence = this.sequence;

    this.broadcast(
      JSON.stringify({
        graphData: JSON.stringify(this.graph),
        sequence,
        type: "graph_snapshot",
      }),
    );

    const updatedAt = await this.persistGraph();
    return { sequence, updatedAt };
  }

  /**
   * Read the object's current in-memory graph and sequence -- used by `fetch()`'s WebSocket
   * connect handler to build a new connection's initial `graph_snapshot`, and available as a
   * plain RPC call for anything else (tests, a future caller) that needs the same snapshot.
   *
   * @returns The graph's current JSON string and sequence number.
   */
  async getSnapshot(): Promise<{ graphData: string; sequence: number }> {
    await this.ensureHydrated();
    return { graphData: JSON.stringify(this.graph), sequence: this.sequence };
  }

  /**
   * Accept a WebSocket upgrade already authorized by the Worker. `../routes/diagrams.ts`'s
   * `GET /api/diagrams/:id/live` route verifies the caller may access this diagram
   * (`DiagramRepository.findAccessible()`) *before* forwarding the request here, appending the
   * caller's verified identity as an `identity` query parameter on the forwarded request -- this
   * object performs no authorization of its own, matching this repository's usual pattern of
   * authorization living at the Worker/API boundary, not inside the Durable Object.
   *
   * Uses the WebSocket Hibernation API (`ctx.acceptWebSocket()`, not `server.accept()`) so an
   * idle open editor tab does not keep billing this object while nothing is happening. Persists
   * the connecting identity via `server.serializeAttachment()` so it survives hibernation --
   * unlike a plain class field (a `Map` keyed by socket, for example), an attachment is the only
   * per-connection state that reliably remains available inside `webSocketMessage()` after this
   * object has hibernated and been re-initialized.
   *
   * Immediately after accepting, sends this one new connection its own `graph_snapshot` and
   * `presence_snapshot` -- both "sent once, immediately on connect"
   * (docs/09C-COLLABORATIVE-EDITING.md's Message Protocol; order between the two does not
   * matter) -- `graph_snapshot` from the object's own in-memory `this.graph`, hydrated from D1
   * if this is the first activity since a cold start, and `presence_snapshot` listing every
   * other currently-connected identity (deduplicated by email, excluding this connecting
   * identity's own email).
   *
   * Before sending anything to the new connection, this method also determines whether this is
   * the *first* open connection for the connecting identity's email (by checking every other
   * already-open socket's attachment) and, if so, broadcasts `presence_joined` to every other
   * connection -- a second tab for an identity that is already known to be present does not
   * trigger a second join broadcast (docs/09C-COLLABORATIVE-EDITING.md's Phase 19 Decision A).
   *
   * @param request Upgrade request forwarded by the Worker, carrying `?identity=<email>`.
   * @returns A `101` WebSocket upgrade response, or a plain `400` for a non-upgrade request.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request.", {
        status: 400,
      });
    }

    await this.ensureHydrated();

    const identity = new URL(request.url).searchParams.get("identity") ?? "";
    const color = colorForEmail(identity);
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({
      color,
      email: identity,
    } satisfies ConnectionAttachment);
    this.ctx.acceptWebSocket(server);

    // Every other socket already open on this diagram, excluding the one just accepted --
    // used both to decide whether to broadcast `presence_joined` and to build this new
    // connection's own `presence_snapshot`.
    const otherOpenSockets = this.ctx
      .getWebSockets()
      .filter(
        (socket) => socket !== server && socket.readyState === WebSocket.OPEN,
      );

    const isFirstConnectionForEmail = !otherOpenSockets.some(
      (socket) =>
        (socket.deserializeAttachment() as ConnectionAttachment).email ===
        identity,
    );

    const otherParticipantsByEmail = new Map<string, ConnectionAttachment>();
    for (const socket of otherOpenSockets) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment;
      if (attachment.email !== identity) {
        otherParticipantsByEmail.set(attachment.email, attachment);
      }
    }

    if (isFirstConnectionForEmail) {
      this.broadcast(
        JSON.stringify({
          color,
          displayName: null,
          email: identity,
          type: "presence_joined",
        }),
        server,
      );
    }

    server.send(
      JSON.stringify({
        graphData: JSON.stringify(this.graph),
        sequence: this.sequence,
        type: "graph_snapshot",
      }),
    );
    server.send(
      JSON.stringify({
        participants: Array.from(otherParticipantsByEmail.values()).map(
          (attachment) => ({
            color: attachment.color,
            displayName: null,
            email: attachment.email,
          }),
        ),
        type: "presence_snapshot",
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle one client-sent frame. Parses `message` as JSON and ignores anything that fails to
   * parse or does not match a known, actionable `type` -- matching this channel's existing
   * "silently ignored" precedent for a genuinely unrecognized frame.
   *
   * For an `{ type: "operation", clientOpId, op }` frame, calls `applyOperation()` with this
   * connection's own attached identity (`origin: "human"`) inside a `try`/`catch`: on success,
   * nothing further happens here -- `applyOperation()` itself already broadcast
   * `operation_applied` to every connection, including this one. On a caught error (a
   * stale-target `notFound()`), sends `{ type: "operation_rejected", clientOpId, reason }` back
   * to this connection only -- never to any other connection, never rethrown, never closing the
   * socket. This is the reconciliation point between `applyOperation()`'s honest-throwing
   * contract and docs/09C-COLLABORATIVE-EDITING.md's Concurrency Model requirement that a
   * stale-target edit never disconnects a socket.
   *
   * For an `{ type: "cursor_moved", x, y }` or `{ type: "selection_changed", nodeId?, edgeId? }`
   * frame, relays it verbatim (with this connection's own attached `email` added) to every
   * *other* open connection -- never persisted, never touching `this.graph`, and never sent
   * back to the sender itself (docs/09C-COLLABORATIVE-EDITING.md's Phase 19 Decision D).
   * Deliberately does not call `ensureHydrated()`: neither frame reads or writes `this.graph`,
   * so relaying correctly does not depend on this object having hydrated yet.
   *
   * For a `{ type: "chat_message", clientRequestId, text }` frame
   * (docs/09D-ARCHITECT-AICHAT.md), **awaits** {@link handleChatMessage} to completion before
   * this method's own returned promise resolves -- deliberately, not fire-and-forget. Two
   * things make this both safe and correct rather than a throughput hazard: (1)
   * `handleChatMessage()` itself never throws (every internal failure is caught and turned into
   * a `chat_error` frame -- see its own JSDoc), so awaiting it here can never turn into an
   * unhandled rejection; and (2) this repository's own confirmed platform finding
   * (docs/DECISIONS.md #35, item 3) is specifically that *this method's own returned promise
   * remaining pending* is what keeps this Durable Object active (not hibernating) for the
   * duration of a multi-round chat turn -- awaiting here is what deliberately extends that
   * guarantee to the whole turn, not an accidental blocking call. It does **not** block a
   * *different* connection's own concurrent `operation`/`cursor_moved`/`chat_message` frame from
   * being handled promptly in the meantime: `handleChatMessage()`'s own first `await` (its call
   * into `../ai/chat-engine.ts`, which itself awaits `env.AI.run()`) already yields control back
   * to this object's event loop, and a synchronous JavaScript execution segment with no `await`
   * in it is the only thing this runtime's input gates ever serialize against a second incoming
   * event (docs/DECISIONS.md #32) -- an outer caller's own still-pending `await` is not.
   *
   * @param ws The connection the frame arrived on.
   * @param message Raw frame payload.
   */
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let parsed: unknown;
    try {
      const text =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (isOperationFrame(parsed)) {
      const { email } = ws.deserializeAttachment() as ConnectionAttachment;
      try {
        await this.applyOperation(parsed.op, email, "human", parsed.clientOpId);
      } catch (error) {
        ws.send(
          JSON.stringify({
            clientOpId: parsed.clientOpId,
            reason:
              error instanceof Error ? error.message : "Operation rejected.",
            type: "operation_rejected",
          }),
        );
      }
      return;
    }

    if (isChatMessageFrame(parsed)) {
      const { email } = ws.deserializeAttachment() as ConnectionAttachment;
      await this.handleChatMessage(
        ws,
        parsed.clientRequestId,
        parsed.text,
        email,
      );
      return;
    }

    if (isCursorMovedFrame(parsed)) {
      const { email } = ws.deserializeAttachment() as ConnectionAttachment;
      this.broadcast(
        JSON.stringify({
          email,
          type: "cursor_moved",
          x: parsed.x,
          y: parsed.y,
        }),
        ws,
      );
      return;
    }

    if (isSelectionChangedFrame(parsed)) {
      const { email } = ws.deserializeAttachment() as ConnectionAttachment;
      this.broadcast(
        JSON.stringify({
          edgeId: parsed.edgeId ?? null,
          email,
          nodeId: parsed.nodeId ?? null,
          type: "selection_changed",
        }),
        ws,
      );
      return;
    }

    // Every other/genuinely unrecognized frame shape is silently ignored, matching this
    // channel's existing precedent.
  }

  /**
   * Run one AI chat turn for `ws` (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool
   * Execution), invoked from {@link webSocketMessage} for an inbound `chat_message` frame.
   * Delegates the actual tool-calling loop to `../ai/chat-engine.ts`'s `runDiagramChatTurn()`,
   * wiring:
   *
   * - `applyMutation` to a closure around {@link applyOperation} with `origin: "ai-chat"`,
   *   catching any thrown error (a stale-target `notFound()`, mirroring
   *   {@link webSocketMessage}'s own existing `operation`-frame try/catch precedent) and
   *   translating it into `{ rejected: true, reason }` rather than letting it propagate --
   *   `chat-engine.ts` feeds that reason back to the model as a tool result instead of failing
   *   the whole turn.
   * - `renameDiagram` to a closure calling `DiagramRepository.updateMetadata()` and, on success,
   *   updating `this.title`/`this.description` and broadcasting `diagram_renamed` to **every**
   *   connection (unlike every other frame this method sends, which is unicast to `ws` only --
   *   see this class's own top-of-file JSDoc's Message Protocol summary for why a rename is a
   *   broadcast).
   * - `onStatus`/`onToken` to unicast `chat_status`/`chat_token` frames to `ws` only.
   * - `onDocsLookup` to a unicast `chat_tool_result` frame to `ws` only.
   *
   * On success, sends `chat_done`, appends the final `{ role: "user" }`/`{ role: "assistant" }`
   * pair to this connection's own ephemeral history (`this.chatHistories`), and logs
   * `ai_chat_turn_completed`. On any thrown error -- from `runDiagramChatTurn()` itself, per its
   * own `@throws` contract -- sends `chat_error` to `ws` only, logs `ai_chat_turn_failed`, and
   * does **not** rethrow: an AI chat turn failing must never crash this connection or this
   * object. Every graph-mutating tool call's own `operation_applied` broadcast (with `origin:
   * "ai-chat"`) already happens for free inside {@link applyOperation} itself -- this method
   * sends no extra broadcast of its own for that.
   *
   * Uses plain `console.log()`/`console.error()` for its three structured log events
   * (`ai_chat_turn_completed`/`ai_chat_turn_failed` here; `ai_docs_lookup_performed` inside
   * `../ai/chat-engine.ts` itself, where the timing/count naturally live) rather than the
   * toolkit's `cloudflareLogger()` -- that middleware resolves a request-scoped logger off a
   * Hono `Context`, which does not exist inside a Durable Object method. This is a narrow,
   * deliberate precedent for structured console logging inside a bare Durable Object, not a
   * general departure from this repository's usual `cloudflareLogger()`-based logging (see
   * docs/DECISIONS.md for a short note on this, if one was added). Never logs prompt/response/
   * diagram content -- only the fields docs/09D-ARCHITECT-AICHAT.md's Data Model section names.
   *
   * @param ws The connection that sent the `chat_message` frame.
   * @param clientRequestId The frame's own correlation id, echoed back on every outbound frame
   * this turn produces.
   * @param text The user's new message text.
   * @param actorEmail This connection's own verified identity.
   */
  private async handleChatMessage(
    ws: WebSocket,
    clientRequestId: string,
    text: string,
    actorEmail: string,
  ): Promise<void> {
    await this.ensureHydrated();
    const diagramId = this.ctx.id.name;
    const startedAt = Date.now();
    const history = this.chatHistories.get(ws) ?? [];

    try {
      const result = await runDiagramChatTurn({
        applyMutation: async (op) => {
          try {
            await this.applyOperation(op, actorEmail, "ai-chat");
            return { rejected: false };
          } catch (error) {
            return {
              reason:
                error instanceof Error ? error.message : "Operation rejected.",
              rejected: true,
            };
          }
        },
        description: this.description,
        env: {
          AI: this.env.AI as unknown as ChatAiBinding,
          AI_CHAT_MODEL: this.env.AI_CHAT_MODEL,
          AI_GATEWAY_ID: this.env.AI_GATEWAY_ID,
        },
        graph: this.graph as GraphData,
        messages: history,
        // Coverage note (docs/DECISIONS.md, Phase 26): this closure's own body is not exercised
        // by any test in this repository. Reaching it requires the model to actually call
        // `search_cloudflare_documentation`, which runs `../ai/docs-client.ts`'s real
        // `Client`/`StreamableHTTPClientTransport` against `https://docs.mcp.cloudflare.com/mcp`
        // -- a genuine outbound network call with no injection seam of its own (the target URL
        // is a literal, and `vi.mock()` cannot reach code executing inside
        // `@cloudflare/vitest-pool-workers`'s own workerd isolate the way it reaches a plain
        // unit test's top-level imports). Forcing that call from an integration test would need
        // real network access on every `test`/`test:coverage` run, exactly the dependency this
        // project's `remoteBindings: false` (docs/DECISIONS.md #9) already exists to avoid for
        // the `AI` binding itself. This closure's own body is trivial, branch-free pass-through
        // (surface `outcome.ok ? outcome.results : { message: outcome.message }` into one
        // `chat_tool_result` frame) with no logic of its own worth a real network dependency to
        // reach; `../ai/chat-engine.test.ts` already covers `executeToolCall()`'s
        // `search_cloudflare_documentation` dispatch (both outcomes) against a mocked
        // `searchCloudflareDocumentationSafe`, and `../ai/docs-client.test.ts` already covers
        // the real parsing/timeout/failure logic this closure merely relays.
        onDocsLookup: (query, outcome) => {
          ws.send(
            JSON.stringify({
              args: { query },
              clientRequestId,
              result: outcome.ok
                ? outcome.results
                : { message: outcome.message },
              tool: "search_cloudflare_documentation",
              type: "chat_tool_result",
            }),
          );
        },
        onStatus: (message) => {
          ws.send(
            JSON.stringify({ clientRequestId, message, type: "chat_status" }),
          );
        },
        onToken: (chunk) => {
          ws.send(
            JSON.stringify({
              clientRequestId,
              text: chunk,
              type: "chat_token",
            }),
          );
        },
        renameDiagram: async (title, description) => {
          const updated = await new DiagramRepository(
            this.env.DB,
          ).updateMetadata(diagramId as string, this.ownerEmail as string, {
            description,
            title,
          });
          if (updated === null) return;
          this.title = updated.title;
          this.description = updated.description;
          this.broadcast(
            JSON.stringify({
              description: updated.description,
              title: updated.title,
              type: "diagram_renamed",
            }),
          );
        },
        text,
        title: this.title as string,
      });

      history.push(
        { content: text, role: "user" },
        { content: result.assistantText, role: "assistant" },
      );
      this.chatHistories.set(ws, history);

      ws.send(
        JSON.stringify({
          assistantText: result.assistantText,
          clientRequestId,
          type: "chat_done",
        }),
      );

      console.log(
        JSON.stringify({
          diagramId,
          event: "ai_chat_turn_completed",
          latencyMs: Date.now() - startedAt,
          model: this.env.AI_CHAT_MODEL,
          mutated: result.mutated,
          toolCallCount: result.toolCallCount,
        }),
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "The assistant hit an unexpected error.";
      ws.send(
        JSON.stringify({
          clientRequestId,
          message: reason,
          type: "chat_error",
        }),
      );
      console.error(
        JSON.stringify({ diagramId, event: "ai_chat_turn_failed", reason }),
      );
    }
  }

  /**
   * Determine whether the identity attached to `ws` -- a connection that just closed or
   * errored -- still has any *other* open connection on this diagram, and broadcast
   * `presence_left` to every remaining connection if not (docs/09C-COLLABORATIVE-EDITING.md's
   * Phase 19 Decision A). `ws` itself is excluded both by reference (its own `readyState` may
   * already be non-`OPEN` by the time this runs, or -- for a hibernation-driven close -- may
   * not reliably reflect that yet) and, redundantly, by the `readyState === OPEN` filter every
   * other still-live socket must also pass.
   *
   * @param ws The connection that just closed or errored.
   */
  private broadcastPresenceLeftIfLastConnection(ws: WebSocket): void {
    const { email } = ws.deserializeAttachment() as ConnectionAttachment;
    const stillConnectedElsewhere = this.ctx
      .getWebSockets()
      .some(
        (socket) =>
          socket !== ws &&
          socket.readyState === WebSocket.OPEN &&
          (socket.deserializeAttachment() as ConnectionAttachment).email ===
            email,
      );
    if (!stillConnectedElsewhere) {
      this.broadcast(JSON.stringify({ email, type: "presence_left" }), ws);
    }
  }

  /** Broadcasts `presence_left` when this was the last open connection for its identity's
   * email -- see {@link broadcastPresenceLeftIfLastConnection}. Also drops `ws`'s own entry (if
   * any) from `this.chatHistories` -- hibernation already discards a closed socket's attachment
   * for free, but `this.chatHistories` is a plain class field keyed by the `WebSocket` object
   * itself (see that field's own JSDoc), which nothing else ever removes, so a connection that
   * chatted and then closed would otherwise keep its history (and the closed socket reference
   * pinning it alive) in memory for as long as this object stays activated. */
  webSocketClose(ws: WebSocket): void {
    this.chatHistories.delete(ws);
    this.broadcastPresenceLeftIfLastConnection(ws);
  }

  /**
   * Same handling as {@link webSocketClose} -- an errored connection is gone exactly like a
   * closed one from this object's presence-tracking point of view.
   *
   * @param ws The connection that errored.
   * @param _error The underlying error. Accepted for parity with the Durable Object
   * `webSocketError` interface signature, but not itself needed: this object treats every
   * errored connection identically regardless of the specific error.
   */
  webSocketError(ws: WebSocket, _error: unknown): void {
    this.chatHistories.delete(ws);
    this.broadcastPresenceLeftIfLastConnection(ws);
  }
}
