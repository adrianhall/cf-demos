import type {
  AuditAction,
  AuditEvent,
  AuditEventInput,
  AuditQuery,
  AuditRepository
} from '../domain/audit';

/**
 * Columns selected for every audit read.
 */
const AUDIT_COLUMNS =
  'id, actor_identity_key, action, resource, reason, correlation_id, created_at';

/**
 * Raw snake_cased audit row as stored in D1.
 */
interface AuditRow {
  /**
   * Event identifier.
   */
  id: string;
  /**
   * Actor identity key, or `null` for scheduled maintenance.
   */
  actor_identity_key: string | null;
  /**
   * Action name.
   */
  action: string;
  /**
   * Resource reference.
   */
  resource: string;
  /**
   * Reason code, or `null`.
   */
  reason: string | null;
  /**
   * Correlation identifier.
   */
  correlation_id: string;
  /**
   * Creation instant.
   */
  created_at: string;
}

/**
 * Convert a stored row into the domain representation.
 *
 * The `action` column is widened back to {@link AuditAction} without re-validation. The union is a
 * write-side constraint — only this application writes the table, and an action that is not in the
 * union could only come from a direct database edit, which the audit trail does not claim to defend
 * against.
 *
 * @param row Row returned by a query using {@link AUDIT_COLUMNS}.
 * @returns The equivalent domain event.
 */
function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    actorIdentityKey: row.actor_identity_key,
    action: row.action as AuditAction,
    resource: row.resource,
    reason: row.reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  };
}

/**
 * D1 implementation of the {@link AuditRepository} port.
 *
 * Append-only by construction: the adapter exposes an insert and two reads, and no update or
 * delete. An audit trail that can be edited through the same application that writes it is not
 * evidence of anything.
 */
export class D1AuditRepository implements AuditRepository {
  /**
   * @param database D1 database bound to this Worker.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * Append one entry.
   *
   * The identifier and timestamp are generated here rather than supplied by the caller, so a
   * service cannot backdate an entry or reuse an identifier.
   *
   * @param input Action to record.
   * @returns The stored entry.
   * @throws {Error} When D1 rejects the insert.
   */
  public async record(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    await this.database
      .prepare(
        'INSERT INTO audit_events (id, actor_identity_key, action, resource, reason, '
          + 'correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        event.id,
        event.actorIdentityKey,
        event.action,
        event.resource,
        event.reason,
        event.correlationId,
        event.createdAt
      )
      .run();
    return event;
  }

  /**
   * Read recent entries, newest first.
   *
   * @param query Action/resource filter and result limit.
   * @returns Matching entries.
   * @throws {Error} When D1 rejects the query.
   */
  public async list(query: AuditQuery): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (query.action !== undefined) {
      conditions.push('action = ?');
      parameters.push(query.action);
    }
    if (query.resource !== undefined) {
      conditions.push('resource = ?');
      parameters.push(query.resource);
    }
    parameters.push(query.limit);

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')} `;
    const result = await this.database
      .prepare(
        `SELECT ${AUDIT_COLUMNS} FROM audit_events ${where}ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .bind(...parameters)
      .all<AuditRow>();
    return result.results.map(toAuditEvent);
  }
}
