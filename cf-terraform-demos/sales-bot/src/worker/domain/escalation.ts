import type { EscalationReason } from './answer-decision';

/**
 * Lifecycle of an escalation.
 *
 * Phase 3 only ever creates an escalation in `open`. The remaining states are declared now because
 * they are the specification's fixed list and the column already stores them; Phase 4 implements
 * the transitions between them. Declaring the full union here rather than a Phase 3 subset means
 * the transition code added later extends a type the repository already round-trips, instead of
 * widening one and having to revisit every `switch`.
 */
export type EscalationStatus =
  | 'open'
  | 'assigned'
  | 'answered'
  | 'delivered'
  | 'closed'
  | 'rejected';

/**
 * One question routed to a person.
 */
export interface Escalation {
  /**
   * Generated escalation identifier.
   */
  id: string;
  /**
   * Conversation the question was asked in.
   */
  conversationId: string;
  /**
   * The question turn that triggered this escalation.
   *
   * Unique in storage: one open escalation per triggering question, which is what makes a retried
   * submission or a double-clicked escalate button produce one queue entry rather than two.
   */
  questionEventId: string;
  /**
   * Product the question was classified as, or `null` when classification found none. A `null`
   * product routes to the default escalation target.
   */
  productId: string | null;
  /**
   * Display name of the person currently responsible, resolved from the product map.
   */
  currentAssignee: string | null;
  /**
   * Why the escalation was opened.
   */
  reason: EscalationReason;
  /**
   * Lifecycle state.
   */
  status: EscalationStatus;
  /**
   * ISO-8601 instant the escalation was opened.
   */
  openedAt: string;
}

/**
 * Persistence port for escalations.
 */
export interface EscalationRepository {
  /**
   * Open an escalation for a question, or return the one that already exists.
   *
   * Idempotent by `questionEventId` rather than failing on a duplicate, because both callers that
   * reach it — the workflow deciding evidence is insufficient, and a requester pressing escalate —
   * can legitimately run twice for one question, and the correct outcome in both cases is one queue
   * entry.
   *
   * @param escalation Fully resolved escalation, including its generated identifier.
   * @returns The stored escalation, whether it was created now or already existed.
   * @throws {Error} When the underlying storage rejects the write.
   */
  open(escalation: Escalation): Promise<Escalation>;

  /**
   * Read the escalation opened for a question, if any.
   *
   * @param questionEventId Turn that triggered the escalation.
   * @returns The escalation, or `null` when the question has not been escalated.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByQuestion(questionEventId: string): Promise<Escalation | null>;
}
