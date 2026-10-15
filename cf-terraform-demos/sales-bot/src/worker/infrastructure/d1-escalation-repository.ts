import type { Escalation, EscalationRepository, EscalationStatus } from '../domain/escalation';

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

/**
 * D1 implementation of the escalation queue's Phase 3 creation boundary.
 */
export class D1EscalationRepository implements EscalationRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}

  /**
   * Insert one escalation or return the existing escalation for the same question.
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
   * Read an escalation by its triggering question.
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
}
