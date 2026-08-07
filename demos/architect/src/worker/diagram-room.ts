import {
  createLogger,
  resolveLoggerConfig,
} from "@adrianhall/cloudflare-toolkit/logging";
import { DurableObject } from "cloudflare:workers";
import type {
  OperationAcceptedFrame,
  OperationRejectedFrame,
  ParticipantJoinedFrame,
  ParticipantLeftFrame,
  Participant,
  ResyncFrame,
  ServerFrame,
  SyncFrame,
} from "../collaboration-protocol";
import {
  MALFORMED_FRAME_CLOSE_CODE,
  MISSING_TRUSTED_IDENTITY_CLOSE_CODE,
} from "../collaboration-protocol";
import { emptyGraphDocument } from "../graph/blueprints";
import { applyGraphOperation, GraphOperationError } from "../graph/operations";
import type { DurableOperation } from "../graph/operations";
import {
  GraphValidationError,
  validateGraphDocument,
} from "../graph/validation";
import type { GraphDocument } from "../graph/types";
import { validateOperationInput } from "./diagrams/operation-input";
import { DiagramRepository } from "./diagrams/repository";
import {
  parseClientFrame,
  parseTrustedIdentity,
  shouldBroadcastCursor,
} from "./diagram-room-protocol";

/**
 * Per-socket state recovered via `deserializeAttachment()` after hibernation — the connection's
 * verified identity/role (set once, at upgrade time, from the Worker's trusted headers) plus the
 * transient cursor rate-limit timestamp described in `docs/09-ARCHITECT.md`'s Collaboration
 * Protocol. Never includes anything from an untrusted client message.
 */
interface SocketAttachment extends Participant {
  /** `Date.now()` epoch milliseconds of this connection's last accepted cursor broadcast. */
  lastCursorBroadcastAt: number;
}

/** Send one frame to a socket only while it is actually open. */
function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

/**
 * Number of recent operations retained in the `operations` table for idempotency lookups.
 *
 * A bounded table (rather than an unbounded audit log) keeps a long-lived diagram's Durable
 * Object storage from growing forever. The trade-off: retrying an operation id older than the
 * most recent {@link OPERATION_HISTORY_LIMIT} accepted edits is no longer recognized as a
 * duplicate — its `baseRevision` will almost certainly no longer match the current revision by
 * then, so it safely falls into the ordinary `stale` path (a full resync) instead of being
 * silently reapplied. No edit can ever be applied twice as a result of this pruning.
 */
const OPERATION_HISTORY_LIMIT = 500;

/** The revision and document returned by every read/write RPC method. */
export interface DocumentSnapshot {
  /** Monotonic revision incremented once per accepted operation. */
  revision: number;
  /** The current authoritative graph document. */
  document: GraphDocument;
}

/** Discriminates the four possible results of {@link DiagramRoom.applyOperation}. */
export type OperationStatus = "accepted" | "duplicate" | "stale" | "rejected";

/**
 * Result of attempting to apply one {@link DurableOperation}, matching Spike 07's measured
 * protocol semantics plus an explicit `"rejected"` status for operations that are well-formed
 * envelopes but fail graph-level validation (unknown node/edge references, an unknown catalog
 * product, and so on) — see `../graph/validation.ts` and `../graph/operations.ts`.
 */
export interface OperationOutcome {
  /**
   * - `"accepted"` — the operation was new and its `baseRevision` matched; it is now persisted.
   * - `"duplicate"` — this `operationId` was already accepted; `revision`/`document` reflect the
   *   result from when it was first accepted, and nothing was re-applied.
   * - `"stale"` — `baseRevision` did not match the current revision; nothing was applied.
   *   `document` is the full current document so the caller can resync and ask the user to retry.
   * - `"rejected"` — the operation could not be applied to this document (a missing node/edge)
   *   or its result failed graph validation. Nothing was applied; `error` explains why.
   */
  status: OperationStatus;
  /** The authoritative revision after processing — unchanged unless `status` is `"accepted"`. */
  revision: number;
  /** The authoritative document after processing — unchanged unless `status` is `"accepted"`. */
  document: GraphDocument;
  /** Present only when `status` is `"rejected"`. */
  error?: string;
}

/** Raw row shape for `document_state`. */
interface DocumentStateRow {
  [column: string]: SqlStorageValue;
  revision: number;
  document_json: string;
}

/** Raw row shape for an idempotency lookup against `operations`. */
interface OperationDedupeRow {
  [column: string]: SqlStorageValue;
  accepted_revision: number;
}

/**
 * `DiagramRoom` is the coordination atom for one live diagram — one Durable Object instance per
 * diagram UUID, addressed by the Worker via `env.DIAGRAM_ROOM.getByName(diagramId)`.
 *
 * Its SQLite storage is the sole authoritative source for the diagram's graph and revision; D1
 * (`../diagrams/repository.ts`) only ever holds directory metadata (title, ownership,
 * timestamps). Phase 2 calls this class's RPC methods directly from Worker route handlers; Phase
 * 4 adds a hibernatable WebSocket `fetch()` upgrade on top of the exact same
 * `document_state`/`operations` schema and `applyOperation` semantics, so the persistence model
 * itself does not change between phases — `webSocketMessage()`'s `"operation"` frame handler
 * calls this same class's own `applyOperation()` RPC method rather than duplicating its logic,
 * and `applyOperation()` remains public so a non-WebSocket caller (Phase 2/3's HTTP
 * `POST /:id/operations` route, `../routes/diagrams.ts`) keeps working unchanged.
 */
export class DiagramRoom extends DurableObject<Env> {
  /**
   * DO-scoped structured logger. There is no per-request Hono context inside a Durable Object
   * (`cloudflareLogger()`, `../middleware/access.ts`'s pattern, only exists on the Worker side),
   * so this constructs one logger directly from
   * `@adrianhall/cloudflare-toolkit/logging`'s framework-agnostic `createLogger`/
   * `resolveLoggerConfig` — the same resolution `cloudflareLogger()` itself performs — once per
   * Durable Object instance rather than per message.
   */
  private readonly logger = createLogger(
    resolveLoggerConfig(this.env.ENVIRONMENT, "worker"),
  );

  /** Create the durable schema and seed an empty revision-0 document before any RPC call. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  /**
   * Read the current authoritative document and revision.
   *
   * The constructor's `blockConcurrencyWhile` already guarantees a fresh room has a seeded
   * revision-0 empty document before this (or any other RPC method) can run, so there is no
   * separate lazy-initialization branch here.
   *
   * @returns The current revision and document.
   */
  async readDocument(): Promise<DocumentSnapshot> {
    return this.currentSnapshot();
  }

  /**
   * Apply one durable, revisioned operation using `storage.transactionSync()`, matching Spike
   * 07's measured atomicity and idempotency semantics.
   *
   * @param operation Envelope validated by the Worker route (`../worker/diagrams/operation-input.ts`)
   * before this is ever called.
   * @returns The outcome — see {@link OperationOutcome} for the four possible statuses.
   */
  async applyOperation(operation: DurableOperation): Promise<OperationOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<OperationDedupeRow>(
          "SELECT accepted_revision FROM operations WHERE operation_id = ?",
          operation.operationId,
        )
        .toArray()[0];
      const current = this.currentSnapshot();

      if (existing) {
        return {
          status: "duplicate",
          revision: existing.accepted_revision,
          document: current.document,
        };
      }
      if (operation.baseRevision !== current.revision) {
        return {
          status: "stale",
          revision: current.revision,
          document: current.document,
        };
      }

      let candidate: GraphDocument;
      try {
        candidate = validateGraphDocument(
          applyGraphOperation(current.document, operation),
        );
      } catch (error) {
        if (
          error instanceof GraphOperationError ||
          error instanceof GraphValidationError
        ) {
          return {
            status: "rejected",
            revision: current.revision,
            document: current.document,
            error: error.message,
          };
        }
        throw error;
      }

      const nextRevision = current.revision + 1;
      this.ctx.storage.sql.exec(
        "UPDATE document_state SET revision = ?, document_json = ? WHERE id = 1",
        nextRevision,
        JSON.stringify(candidate),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO operations (operation_id, base_revision, accepted_revision, kind, payload_json) VALUES (?, ?, ?, ?, ?)",
        operation.operationId,
        operation.baseRevision,
        nextRevision,
        operation.kind,
        JSON.stringify(operation.payload),
      );
      this.pruneOperations();

      return {
        status: "accepted",
        revision: nextRevision,
        document: candidate,
      };
    });
  }

  /**
   * Permanently delete this room's storage and immediately reinitialize an empty schema.
   *
   * Reinitializing here — rather than relying on eviction to re-run the constructor — guarantees
   * that a diagram id reused right after deletion (or a stray call while the diagram still
   * exists) never hits a `no such table` error; see the `testing-durable-objects` skill's
   * schema-recreation rule.
   *
   * Phase 2 does not expose a diagram-deletion HTTP API — the brief left that decision to this
   * implementation, and deletion is out of scope for a "create, edit, reload, reopen" phase — but
   * this cleanup method exists now and is integration-tested because Phase 3+ (revoking the last
   * member, an owner deleting a diagram) will need it.
   *
   * @returns Promise resolved after all storage is deleted and the schema is recreated.
   */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.initializeSchema();
  }

  /**
   * Accept a Worker-authenticated hibernatable WebSocket upgrade.
   *
   * Reads the trusted `X-Architect-Identity`/`X-Architect-Role` headers `../routes/diagrams.ts`
   * always sets after its own membership check — see `./diagram-room-protocol.ts`'s
   * `parseTrustedIdentity()`. A request missing either header (unreachable through the real
   * Worker route; only possible if something bypassed it entirely) still completes the upgrade
   * handshake but immediately closes the resulting socket with
   * `MISSING_TRUSTED_IDENTITY_CLOSE_CODE`, so the Durable Object never accepts messages from an
   * unverified connection.
   *
   * @param request Upgrade request, forwarded by `../routes/diagrams.ts` with trusted headers.
   * @returns A `101` WebSocket-upgrade response, or `426` when the request is not an actual
   * `Upgrade: websocket` request (a direct, non-upgrade call to this Durable Object).
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const identity = parseTrustedIdentity(request.headers);
    const [client, server] = Object.values(new WebSocketPair());
    if (!identity) {
      this.ctx.acceptWebSocket(server);
      server.close(
        MISSING_TRUSTED_IDENTITY_CLOSE_CODE,
        "Missing trusted identity.",
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    const attachment: SocketAttachment = {
      ...identity,
      lastCursorBroadcastAt: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    const snapshot = this.currentSnapshot();
    send(server, {
      type: "sync",
      revision: snapshot.revision,
      document: snapshot.document,
      participants: this.participants(),
    } satisfies SyncFrame);

    this.broadcast(
      {
        type: "participant_joined",
        participant: identity,
        participants: this.participants(),
      } satisfies ParticipantJoinedFrame,
      server,
    );
    this.logger.info("participant_joined", {
      role: identity.role,
      participants: this.ctx.getWebSockets().length,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Route one validated collaboration frame after a (possibly just-woken, hibernating) socket
   * receives it.
   *
   * A durable `"operation"` frame is validated with the exact same
   * `../diagrams/operation-input.ts`'s `validateOperationInput()` the HTTP
   * `POST /:id/operations` route uses, then applied through this class's own public
   * `applyOperation()` — the same persist-before-broadcast logic, not a second implementation. A
   * transient `"cursor"` frame is rate-limited to one broadcast per socket every 50 ms
   * (`./diagram-room-protocol.ts`'s `shouldBroadcastCursor()`) and never persisted.
   *
   * @param socket The connection the frame arrived on.
   * @param message Raw incoming WebSocket frame.
   * @returns Promise resolved once the frame has been handled, rejected, or the socket has been
   * closed for being malformed.
   */
  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      socket.close(
        MISSING_TRUSTED_IDENTITY_CLOSE_CODE,
        "Missing trusted identity.",
      );
      return;
    }

    const frame = parseClientFrame(message);
    if (!frame) {
      socket.close(
        MALFORMED_FRAME_CLOSE_CODE,
        "Malformed collaboration frame.",
      );
      return;
    }

    if (frame.type === "cursor") {
      const now = Date.now();
      if (!shouldBroadcastCursor(attachment.lastCursorBroadcastAt, now)) {
        return;
      }
      const updated: SocketAttachment = {
        ...attachment,
        lastCursorBroadcastAt: now,
      };
      socket.serializeAttachment(updated);
      this.broadcast(
        {
          type: "cursor",
          email: attachment.email,
          role: attachment.role,
          x: frame.x,
          y: frame.y,
          selection: frame.selection,
        },
        socket,
      );
      return;
    }

    let operation: DurableOperation;
    try {
      operation = validateOperationInput(frame.operation);
    } catch {
      socket.close(
        MALFORMED_FRAME_CLOSE_CODE,
        "Malformed collaboration operation.",
      );
      return;
    }

    const outcome = await this.applyOperation(operation);
    await this.reportOperationOutcome(socket, operation, outcome);
  }

  /**
   * Clean up and notify the room after a socket closes normally.
   *
   * @param socket The socket that closed.
   */
  webSocketClose(socket: WebSocket): void {
    this.handleDisconnect(socket);
  }

  /**
   * Clean up and notify the room after a socket terminates with an error.
   *
   * @param socket The socket that errored.
   */
  webSocketError(socket: WebSocket): void {
    this.handleDisconnect(socket);
  }

  /**
   * Broadcast the outcome of one applied `"operation"` frame to the right audience, per
   * `docs/09-ARCHITECT.md`'s Collaboration Protocol:
   *
   * - `"accepted"` — broadcast `operation_accepted` to every connected socket, sender included,
   *   so every client converges on the identical result.
   * - `"duplicate"` — send `operation_accepted` (with `duplicate: true`) to the retrying sender
   *   only. This intentionally diverges from `spikes/07-architect-collaboration/REPORT.md`'s
   *   probe, which re-broadcast a duplicate to everyone — every *other* participant's state
   *   already reflects this operation, so re-broadcasting to them is redundant.
   * - `"stale"` — send `resync` (the full current document) to the sender only. Never merged
   *   automatically; the client must ask the user to retry.
   * - `"rejected"` — send `operation_rejected` (with the validation error) to the sender only.
   *
   * @param socket The socket that submitted the operation.
   * @param operation The operation envelope that was applied.
   * @param outcome The result from `applyOperation()`.
   */
  private async reportOperationOutcome(
    socket: WebSocket,
    operation: DurableOperation,
    outcome: OperationOutcome,
  ): Promise<void> {
    switch (outcome.status) {
      case "accepted": {
        this.broadcast({
          type: "operation_accepted",
          operationId: operation.operationId,
          revision: outcome.revision,
          duplicate: false,
          document: outcome.document,
        } satisfies OperationAcceptedFrame);
        this.logger.info("operation_accepted", {
          kind: operation.kind,
          revision: outcome.revision,
          duplicate: false,
        });
        await this.touchDiagramUpdatedAt();
        return;
      }
      case "duplicate": {
        send(socket, {
          type: "operation_accepted",
          operationId: operation.operationId,
          revision: outcome.revision,
          duplicate: true,
          document: outcome.document,
        } satisfies OperationAcceptedFrame);
        this.logger.info("operation_accepted", {
          kind: operation.kind,
          revision: outcome.revision,
          duplicate: true,
        });
        return;
      }
      case "stale": {
        send(socket, {
          type: "resync",
          revision: outcome.revision,
          document: outcome.document,
        } satisfies ResyncFrame);
        return;
      }
      case "rejected": {
        send(socket, {
          type: "operation_rejected",
          operationId: operation.operationId,
          error: outcome.error ?? "The edit was rejected.",
        } satisfies OperationRejectedFrame);
        this.logger.warn("operation_rejected", { kind: operation.kind });
        return;
      }
      default: {
        // Exhaustiveness guard: a new OperationStatus added without a case here is a
        // compile-time error at this line, not a silent runtime no-op.
        const exhaustive: never = outcome.status;
        throw new Error(`Unsupported operation outcome: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Record in D1 that this diagram's document changed, mirroring the HTTP
   * `POST /:id/operations` route's own `DiagramRepository.touchUpdatedAt()` call
   * (`../routes/diagrams.ts`) so a diagram edited only through live collaboration still sorts
   * correctly in the owner's library by "most recently updated."
   *
   * `this.ctx.id.name` is the diagram UUID this room was addressed with (`getByName(diagramId)`)
   * — intrinsic to the Durable Object's own id and available even after hibernation, so no
   * separate persisted or forwarded copy of the diagram id is needed here.
   *
   * @returns Promise resolved after the D1 update completes, or immediately if this room's id
   * somehow has no associated name (only possible if it were addressed by a raw id rather than
   * `getByName()`, which never happens in this codebase).
   */
  private async touchDiagramUpdatedAt(): Promise<void> {
    const diagramId = this.ctx.id.name;
    if (!diagramId) {
      return;
    }
    await new DiagramRepository(this.env.DB).touchUpdatedAt(diagramId);
  }

  /**
   * Broadcast one participant join/leave notification and structured log entry after a socket
   * disconnects, deriving the departing identity from its own attachment before it is dropped
   * from `ctx.getWebSockets()`.
   *
   * @param socket The socket that just closed or errored.
   */
  private handleDisconnect(socket: WebSocket): void {
    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      return;
    }
    this.broadcast({
      type: "participant_left",
      participant: { email: attachment.email, role: attachment.role },
      participants: this.participants(),
    } satisfies ParticipantLeftFrame);
    this.logger.info("participant_left", {
      role: attachment.role,
      participants: this.ctx.getWebSockets().length,
    });
  }

  /** @returns Every currently connected participant, derived from active WebSockets — never a persisted table. */
  private participants(): Participant[] {
    const seen: Participant[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment) {
        seen.push({ email: attachment.email, role: attachment.role });
      }
    }
    return seen;
  }

  /**
   * Send one frame to every currently connected socket, optionally skipping one.
   *
   * @param frame Frame to broadcast.
   * @param exclude A socket to skip — used for a `"cursor"` broadcast (the sender already knows
   * its own cursor) and the `participant_joined` broadcast (the new connection already received
   * the same information in its own `sync` frame).
   */
  private broadcast(frame: ServerFrame, exclude?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) {
        continue;
      }
      send(socket, frame);
    }
  }

  /** Create the `document_state`/`operations` tables and seed revision 0 if not already done. */
  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS document_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        document_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        base_revision INTEGER NOT NULL,
        accepted_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    const existing = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; count: number }>(
        "SELECT COUNT(*) AS count FROM document_state",
      )
      .one().count;
    if (existing === 0) {
      this.ctx.storage.sql.exec(
        "INSERT INTO document_state (id, revision, document_json) VALUES (1, 0, ?)",
        JSON.stringify(emptyGraphDocument),
      );
    }
  }

  /** Read the singleton authoritative revision and document in one query. */
  private currentSnapshot(): DocumentSnapshot {
    const row = this.ctx.storage.sql
      .exec<DocumentStateRow>(
        "SELECT revision, document_json FROM document_state WHERE id = 1",
      )
      .one();
    return {
      revision: row.revision,
      document: JSON.parse(row.document_json) as GraphDocument,
    };
  }

  /** Drop every operation record older than the {@link OPERATION_HISTORY_LIMIT} most recent. */
  private pruneOperations(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM operations WHERE operation_id NOT IN (
        SELECT operation_id FROM operations ORDER BY accepted_revision DESC LIMIT ?
      )`,
      OPERATION_HISTORY_LIMIT,
    );
  }
}
