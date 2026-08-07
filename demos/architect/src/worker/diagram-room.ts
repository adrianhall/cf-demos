import { DurableObject } from "cloudflare:workers";
import { emptyGraphDocument } from "../graph/blueprints";
import { applyGraphOperation, GraphOperationError } from "../graph/operations";
import type { DurableOperation } from "../graph/operations";
import {
  GraphValidationError,
  validateGraphDocument,
} from "../graph/validation";
import type { GraphDocument } from "../graph/types";

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
 * itself does not change between phases.
 */
export class DiagramRoom extends DurableObject<Env> {
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
