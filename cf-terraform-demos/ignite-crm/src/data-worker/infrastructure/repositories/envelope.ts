/**
 * @file SQL for the audit and idempotency rows every mutation commits, plus the idempotency lookup.
 */

import type {
  IdempotencyRepository,
  MutationEnvelope,
  StoredIdempotency
} from '../../application/shared/mutations.ts';
import { type D1Reader, type D1TransactionPort, sql } from '../d1/d1-port.ts';

/**
 * Queue the envelope's writes: audit events, the idempotency record, and a purge of expired
 * idempotency records.
 *
 * The idempotency insert is a plain `INSERT`: if a concurrent request with the same key committed
 * first, the primary key fails and the whole batch — including the business change — rolls back
 * with `CONFLICT`, so two racing retries can never both apply.
 *
 * @param tx The open transaction.
 * @param envelope The rows.
 */
export function writeEnvelope(tx: D1TransactionPort, envelope: MutationEnvelope): void {
  for (const event of envelope.audit) {
    tx.write(
      sql(
        `INSERT INTO audit_events
           (id, module, entity_type, entity_id, action, actor_id, channel, request_id, metadata_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.module,
        event.entityType,
        event.entityId,
        event.action,
        event.actorId,
        event.channel,
        event.requestId,
        JSON.stringify(event.metadata),
        event.occurredAt
      )
    );
  }
  const record = envelope.idempotency;
  tx.write(sql('DELETE FROM idempotency_records WHERE created_at < ?', envelope.purgeBefore));
  tx.write(
    sql(
      `INSERT INTO idempotency_records
         (actor_id, operation, idempotency_key, request_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      record.actorId,
      record.operation,
      record.key,
      record.requestHash,
      record.resultJson,
      record.createdAt
    )
  );
}

/**
 * Idempotency lookup over D1.
 */
export class D1IdempotencyReader implements IdempotencyRepository {
  /**
   * @param db Read access.
   */
  constructor(protected readonly db: D1Reader) {}

  /**
   * @inheritdoc
   */
  async findIdempotency(
    actorId: string,
    operation: string,
    key: string,
    notBefore: string
  ): Promise<StoredIdempotency | null> {
    const row = await this.db.readOne<{ request_hash: string; result_json: string }>(
      sql(
        `SELECT request_hash, result_json FROM idempotency_records
          WHERE actor_id = ? AND operation = ? AND idempotency_key = ? AND created_at >= ?`,
        actorId,
        operation,
        key,
        notBefore
      )
    );
    return row === null ? null : { requestHash: row.request_hash, resultJson: row.result_json };
  }
}
