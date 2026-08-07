/** @file Minimal local Durable Object collaboration protocol for Spike 07. */
import { DurableObject } from "cloudflare:workers";

/** Close code for malformed client frames. */
export const INVALID_FRAME_CLOSE_CODE = 4400;

/** Close code for a Worker-to-Durable-Object identity seam failure. */
export const TRUSTED_IDENTITY_CLOSE_CODE = 4401;

/** Minimum interval between transient cursor broadcasts from one connection. */
export const CURSOR_RATE_LIMIT_MS = 50;

/** The renderer-independent, deliberately tiny diagram used by this probe. */
export interface DiagramDocument {
  /** Monotonic revision incremented for each accepted persisted edit. */
  revision: number;
  /** Nodes whose final positions are durable state. */
  nodes: Array<{ id: string; x: number; y: number }>;
}

/** Identity injected only by the local Worker upgrade handler. */
interface TrustedIdentity {
  /** Stand-in verified email. */
  email: string;
  /** Stand-in membership role. */
  role: "owner" | "editor";
  /** Timestamp used only to identify a connection in presence frames. */
  connectedAt: number;
  /** Last transient cursor time, retained only in the socket attachment. */
  lastCursorAt: number;
}

/** A final-position operation accepted by the room. */
interface FinalPositionOperation {
  /** Client-generated idempotency key. */
  operationId: string;
  /** Revision the client edited. */
  baseRevision: number;
  /** The only durable edit supported by this minimal spike. */
  kind: "final_position";
  /** Validated final node coordinates. */
  payload: { nodeId: string; x: number; y: number };
}

/** The complete set of inbound frames accepted by this spike. */
type InboundFrame =
  | { type: "operation"; operation: FinalPositionOperation }
  | { type: "cursor"; x: number; y: number; selection?: string };

/** The atomic SQLite result of attempting an operation. */
interface OperationResult {
  /** Whether the operation was accepted or a harmless retry. */
  accepted: boolean;
  /** Whether an already-persisted operation id caused the result. */
  duplicate: boolean;
  /** The authoritative document after processing. */
  document: DiagramDocument;
  /** The authoritative revision after processing. */
  revision: number;
}

/** Decode a JSON object without accepting arrays or primitives. */
function jsonObject(value: string | ArrayBuffer): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Return an inbound frame only when every required field has the expected shape. */
function parseFrame(value: string | ArrayBuffer): InboundFrame | null {
  const frame = jsonObject(value);
  if (frame?.type === "cursor" && typeof frame.x === "number" && typeof frame.y === "number") {
    return typeof frame.selection === "string" || frame.selection === undefined
      ? { type: "cursor", x: frame.x, y: frame.y, selection: frame.selection }
      : null;
  }
  if (frame?.type !== "operation" || typeof frame.operation !== "object" || frame.operation === null) return null;
  const operation = frame.operation as Record<string, unknown>;
  const rawPayload = operation.payload;
  const payload = typeof rawPayload === "object" && rawPayload !== null && !Array.isArray(rawPayload)
    ? rawPayload as Record<string, unknown>
    : null;
  if (
    operation.kind !== "final_position" ||
    typeof operation.operationId !== "string" ||
    typeof operation.baseRevision !== "number" ||
    payload === null ||
    typeof payload.nodeId !== "string" ||
    typeof payload.x !== "number" ||
    typeof payload.y !== "number"
  ) {
    return null;
  }
  return {
    type: "operation",
    operation: {
      operationId: operation.operationId,
      baseRevision: operation.baseRevision,
      kind: "final_position",
      payload: { nodeId: payload.nodeId, x: payload.x, y: payload.y },
    },
  };
}

/** Owns one diagram's authoritative document, idempotency records, and hibernatable sockets. */
export class DiagramRoom extends DurableObject<Env> {
  /** Creates the schema before any message may read it. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.initializeSchema());
  }

  /** Upgrades only Worker-forwarded requests that contain trusted identity headers. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade.", { status: 426 });
    }
    const email = request.headers.get("x-spike-trusted-email");
    const role = request.headers.get("x-spike-trusted-role");
    if (!email || (role !== "owner" && role !== "editor")) {
      return new Response("Missing trusted identity.", { status: 403 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const identity: TrustedIdentity = { email, role, connectedAt: Date.now(), lastCursorAt: 0 };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(identity);
    server.send(JSON.stringify({ type: "sync", document: this.document() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Routes validated collaboration frames after a hibernating object wakes. */
  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    const identity = this.identity(socket);
    if (!identity) return;
    const frame = parseFrame(value);
    if (!frame) {
      socket.close(INVALID_FRAME_CLOSE_CODE, "Invalid collaboration frame.");
      return;
    }
    if (frame.type === "cursor") {
      const now = Date.now();
      if (now - identity.lastCursorAt < CURSOR_RATE_LIMIT_MS) return;
      identity.lastCursorAt = now;
      socket.serializeAttachment(identity);
      this.broadcast({ type: "cursor", email: identity.email, x: frame.x, y: frame.y, selection: frame.selection });
      return;
    }

    const result = this.applyOperation(frame.operation);
    if (!result.accepted) {
      socket.send(JSON.stringify({ type: "resync", document: result.document, revision: result.revision }));
      return;
    }
    this.broadcast({
      type: "operation_accepted",
      operationId: frame.operation.operationId,
      revision: result.revision,
      duplicate: result.duplicate,
      document: result.document,
    });
  }

  /** Returns plain persisted state for integration-test inspection. */
  inspect(): { revision: number; operationCount: number; nodes: Array<{ id: string; x: number; y: number }> } {
    const document = this.document();
    const operationCount = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one().count;
    return { revision: document.revision, operationCount, nodes: document.nodes };
  }

  /** Sends a current attachment identity back to a client after hibernation. */
  private identity(socket: WebSocket): TrustedIdentity | null {
    const value = socket.deserializeAttachment() as TrustedIdentity | null;
    if (!value) {
      socket.close(TRUSTED_IDENTITY_CLOSE_CODE, "Trusted identity was unavailable.");
      return null;
    }
    return value;
  }

  /** Creates both tables and inserts the deterministic two-node starter document once. */
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
    const existing = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM document_state").one().count;
    if (existing === 0) {
      const document: DiagramDocument = { revision: 0, nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 200, y: 0 }] };
      this.ctx.storage.sql.exec("INSERT INTO document_state (id, revision, document_json) VALUES (1, 0, ?)", JSON.stringify(document));
    }
  }

  /** Reads the singleton authoritative document. */
  private document(): DiagramDocument {
    const row = this.ctx.storage.sql.exec<{ document_json: string }>("SELECT document_json FROM document_state WHERE id = 1").one();
    return JSON.parse(row.document_json) as DiagramDocument;
  }

  /** Atomically deduplicates, validates the base revision, and persists an accepted final position. */
  private applyOperation(operation: FinalPositionOperation): OperationResult {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<{ accepted_revision: number }>("SELECT accepted_revision FROM operations WHERE operation_id = ?", operation.operationId).toArray()[0];
      const document = this.document();
      if (existing) {
        return { accepted: true, duplicate: true, document, revision: existing.accepted_revision };
      }
      if (operation.baseRevision !== document.revision) {
        return { accepted: false, duplicate: false, document, revision: document.revision };
      }
      const node = document.nodes.find((candidate) => candidate.id === operation.payload.nodeId);
      if (!node) {
        return { accepted: false, duplicate: false, document, revision: document.revision };
      }
      node.x = operation.payload.x;
      node.y = operation.payload.y;
      document.revision += 1;
      this.ctx.storage.sql.exec("UPDATE document_state SET revision = ?, document_json = ? WHERE id = 1", document.revision, JSON.stringify(document));
      this.ctx.storage.sql.exec("INSERT INTO operations (operation_id, base_revision, accepted_revision, kind, payload_json) VALUES (?, ?, ?, ?, ?)", operation.operationId, operation.baseRevision, document.revision, operation.kind, JSON.stringify(operation.payload));
      return { accepted: true, duplicate: false, document, revision: document.revision };
    });
  }

  /** Broadcasts a structured-clone-safe frame to every currently connected participant. */
  private broadcast(frame: Record<string, unknown>): void {
    const encoded = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }
}

/** Selects a deterministic local stand-in identity; production Access is deliberately absent. */
function localIdentity(request: Request): { email: string; role: "owner" | "editor" } | null {
  switch (request.headers.get("x-spike-client")) {
    case "alice": return { email: "alice@example.test", role: "owner" };
    case "bob": return { email: "bob@example.test", role: "editor" };
    default: return null;
  }
}

/** Upgrades local collaboration requests and is the sole source of trusted DO identity headers. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/rooms\/([a-z0-9-]+)$/);
    const identity = localIdentity(request);
    if (!match || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Not found.", { status: 404 });
    if (!identity) return new Response("Unknown local client.", { status: 401 });
    const headers = new Headers(request.headers);
    headers.delete("x-spike-trusted-email");
    headers.delete("x-spike-trusted-role");
    headers.set("x-spike-trusted-email", identity.email);
    headers.set("x-spike-trusted-role", identity.role);
    return env.DIAGRAM_ROOM.getByName(match[1]).fetch(new Request(request, { headers }));
  },
};
