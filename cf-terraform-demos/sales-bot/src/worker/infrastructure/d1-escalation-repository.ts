import type {
  Escalation,
  EscalationAssignment,
  EscalationRepository,
  EscalationStatus
} from '../domain/escalation';

interface EscalationRow {
  id: string;
  conversation_id: string;
  question_event_id: string;
  product_id: string | null;
  current_assignee: string | null;
  reason: string | null;
  status: string;
  opened_at: string;
}
interface AssignmentRow {
  id: string;
  escalation_id: string;
  actor_identity_key: string | null;
  previous_assignee: string | null;
  current_assignee: string;
  reason: string;
  created_at: string;
}
function toStatus(value: string): EscalationStatus {
  return value === 'assigned'
    || value === 'answered'
    || value === 'delivered'
    || value === 'closed'
    || value === 'rejected'
    ? value
    : 'open';
}
function toEscalation(row: EscalationRow): Escalation {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    questionEventId: row.question_event_id,
    productId: row.product_id,
    currentAssignee: row.current_assignee,
    reason:
      row.reason === 'requested' || row.reason === 'restricted_evidence'
        ? row.reason
        : 'insufficient_evidence',
    status: toStatus(row.status),
    openedAt: row.opened_at
  };
}
function toAssignment(row: AssignmentRow): EscalationAssignment {
  return {
    id: row.id,
    escalationId: row.escalation_id,
    actorIdentityKey: row.actor_identity_key,
    previousAssignee: row.previous_assignee,
    currentAssignee: row.current_assignee,
    reason: row.reason,
    createdAt: row.created_at
  };
}
/**
 * D1 implementation of the authoritative escalation queue.
 */
export class D1EscalationRepository implements EscalationRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}
  /**
   * Insert one escalation or return its idempotent predecessor.
   */
  public async open(escalation: Escalation): Promise<Escalation> {
    await this.database
      .prepare(
        'INSERT OR IGNORE INTO escalations (id, conversation_id, question_event_id, product_id, current_assignee, status, opened_at, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
      )
      .bind(
        escalation.id,
        escalation.conversationId,
        escalation.questionEventId,
        escalation.productId,
        escalation.currentAssignee,
        escalation.status,
        escalation.openedAt,
        escalation.reason
      )
      .run();
    const stored = await this.findByQuestion(escalation.questionEventId);
    if (stored === null) throw new Error('D1 did not return the escalation it just stored.');
    return stored;
  }
  /**
   * Read an escalation by identifier.
   */
  public async find(id: string): Promise<Escalation | null> {
    const row = await this.database
      .prepare(
        'SELECT id, conversation_id, question_event_id, product_id, current_assignee, reason, status, opened_at FROM escalations WHERE id = ?1'
      )
      .bind(id)
      .first<EscalationRow>();
    return row === null ? null : toEscalation(row);
  }
  /**
   * Read an escalation by triggering question.
   */
  public async findByQuestion(questionEventId: string): Promise<Escalation | null> {
    const row = await this.database
      .prepare(
        'SELECT id, conversation_id, question_event_id, product_id, current_assignee, reason, status, opened_at FROM escalations WHERE question_event_id = ?1'
      )
      .bind(questionEventId)
      .first<EscalationRow>();
    return row === null ? null : toEscalation(row);
  }
  /**
   * List entries available to the supplied product scope.
   */
  public async list(productIds: string[] | null): Promise<Escalation[]> {
    if (productIds !== null && productIds.length === 0) return [];
    const placeholders = productIds?.map((_, index) => `?${index + 1}`).join(', ') ?? '';
    const query =
      productIds === null
        ? 'SELECT id, conversation_id, question_event_id, product_id, current_assignee, reason, status, opened_at FROM escalations ORDER BY opened_at ASC'
        : `SELECT id, conversation_id, question_event_id, product_id, current_assignee, reason, status, opened_at FROM escalations WHERE product_id IN (${placeholders}) ORDER BY opened_at ASC`;
    const statement = this.database.prepare(query);
    const result =
      productIds === null
        ? await statement.all<EscalationRow>()
        : await statement.bind(...productIds).all<EscalationRow>();
    return result.results.map(toEscalation);
  }
  /**
   * Read assignment history.
   */
  public async assignments(escalationId: string): Promise<EscalationAssignment[]> {
    const result = await this.database
      .prepare(
        'SELECT id, escalation_id, actor_identity_key, previous_assignee, current_assignee, reason, created_at FROM escalation_assignments WHERE escalation_id = ?1 ORDER BY created_at ASC, id ASC'
      )
      .bind(escalationId)
      .all<AssignmentRow>();
    return result.results.map(toAssignment);
  }
  /**
   * Atomically store a reassignment and its resulting queue state.
   */
  public async assign(escalation: Escalation, assignment: EscalationAssignment): Promise<void> {
    await this.database.batch([
      this.database
        .prepare('UPDATE escalations SET current_assignee = ?2, status = ?3 WHERE id = ?1')
        .bind(escalation.id, escalation.currentAssignee, escalation.status),
      this.database
        .prepare(
          'INSERT INTO escalation_assignments (id, escalation_id, actor_identity_key, previous_assignee, current_assignee, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
        )
        .bind(
          assignment.id,
          assignment.escalationId,
          assignment.actorIdentityKey,
          assignment.previousAssignee,
          assignment.currentAssignee,
          assignment.reason,
          assignment.createdAt
        )
    ]);
  }
  /**
   * Persist an escalation lifecycle state.
   */
  public async update(escalation: Escalation): Promise<void> {
    await this.database
      .prepare(
        "UPDATE escalations SET current_assignee = ?2, status = ?3, answered_at = CASE WHEN ?3 = 'answered' THEN ?4 ELSE answered_at END, closed_at = CASE WHEN ?3 IN ('closed', 'rejected') THEN ?4 ELSE closed_at END WHERE id = ?1"
      )
      .bind(escalation.id, escalation.currentAssignee, escalation.status, new Date().toISOString())
      .run();
  }
}
