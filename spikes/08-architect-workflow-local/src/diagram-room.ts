import { DurableObject } from "cloudflare:workers";
import type { ProgressNotification } from "./contracts";

/** SQLite-backed room that records Workflow progress in delivery order. */
export class DiagramRoom extends DurableObject<Env> {
  /** Initializes the notification table before the room accepts RPC calls. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => this.initializeSchema());
  }

  /**
   * Persists a notification before returning to the Workflow, preserving completion order.
   *
   * @param notification Job state transition to append.
   * @returns The notification with its room-assigned monotonic sequence.
   */
  async notify(notification: Omit<ProgressNotification, "sequence">): Promise<ProgressNotification> {
    const sequence = this.ctx.storage.sql.exec<{ sequence: number }>(
      "INSERT INTO notifications (job_id, status, proposal_key, failure_reason) VALUES (?, ?, ?, ?) RETURNING sequence",
      notification.jobId,
      notification.status,
      notification.proposalKey ?? null,
      notification.failureReason ?? null,
    ).one().sequence;
    return { ...notification, sequence };
  }

  /** Returns persisted notification history as plain structured-cloneable data. */
  async history(): Promise<ProgressNotification[]> {
    return this.ctx.storage.sql.exec<NotificationRow>(
      "SELECT job_id AS jobId, status, sequence, proposal_key AS proposalKey, failure_reason AS failureReason FROM notifications ORDER BY sequence",
    ).toArray().map((row) => ({
      jobId: row.jobId,
      status: row.status,
      sequence: row.sequence,
      ...(row.proposalKey === null ? {} : { proposalKey: row.proposalKey }),
      ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    }));
  }

  /** Creates the room's persistent table if it was removed by test cleanup. */
  private initializeSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notifications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, status TEXT NOT NULL, proposal_key TEXT, failure_reason TEXT)",
    );
  }
}

/** SQL row shape used only at the Durable Object storage boundary. */
type NotificationRow = Record<string, SqlStorageValue> & {
  jobId: string;
  status: ProgressNotification["status"];
  sequence: number;
  proposalKey: string | null;
  failureReason: string | null;
};
