import type { EscalationReason } from './answer-decision';

/**
 * Lifecycle of an escalation.
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
   */
  questionEventId: string;
  /**
   * Product the question was classified as, or `null` when classification found none.
   */
  productId: string | null;
  /**
   * Display name of the person currently responsible.
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
 * One immutable routing decision in an escalation's lifetime.
 */
export interface EscalationAssignment {
  /**
   * Generated assignment identifier.
   */
  id: string;
  /**
   * Escalation receiving the assignment.
   */
  escalationId: string;
  /**
   * Verified identity that made the assignment, or `null` for automatic routing.
   */
  actorIdentityKey: string | null;
  /**
   * Assignee before this transition, or `null` for initial routing.
   */
  previousAssignee: string | null;
  /**
   * Newly responsible PM display name.
   */
  currentAssignee: string;
  /**
   * Why this routing decision occurred.
   */
  reason: string;
  /**
   * ISO-8601 instant the assignment was recorded.
   */
  createdAt: string;
}

/**
 * True when a lifecycle state can transition to the requested state.
 */
export function canTransition(from: EscalationStatus, to: EscalationStatus): boolean {
  return (
    (from === 'open' && (to === 'assigned' || to === 'rejected'))
    || (from === 'assigned' && (to === 'answered' || to === 'rejected'))
    || (from === 'answered' && to === 'delivered')
    || (from === 'delivered' && to === 'closed')
  );
}

/**
 * Persistence port for escalations.
 */
export interface EscalationRepository {
  /**
   * Open an escalation for a question, or return the one that already exists.
   *
   * @param escalation Fully resolved escalation, including its generated identifier.
   * @returns The stored escalation, whether it was created now or already existed.
   * @throws {Error} When the underlying storage rejects the write.
   */
  open(escalation: Escalation): Promise<Escalation>;
  /**
   * Read one escalation.
   *
   * @param id Escalation identifier.
   * @returns The escalation, or `null` when unknown.
   * @throws {Error} When the underlying storage rejects the read.
   */
  find(id: string): Promise<Escalation | null>;
  /**
   * Read the escalation opened for a question, if any.
   *
   * @param questionEventId Turn that triggered the escalation.
   * @returns The escalation, or `null` when the question has not been escalated.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findByQuestion(questionEventId: string): Promise<Escalation | null>;
  /**
   * List queue entries matching product scope.
   *
   * @param productIds Permitted products; `null` permits all products.
   * @returns Queue entries, oldest first.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(productIds: string[] | null): Promise<Escalation[]>;
  /**
   * Read immutable assignment history.
   *
   * @param escalationId Escalation identifier.
   * @returns Assignment history, oldest first.
   * @throws {Error} When the underlying storage rejects the read.
   */
  assignments(escalationId: string): Promise<EscalationAssignment[]>;
  /**
   * Persist an assignment and state atomically.
   *
   * @param escalation Updated escalation.
   * @param assignment Assignment history item.
   * @returns A promise fulfilled once both facts are durable.
   * @throws {Error} When the underlying storage rejects the write.
   */
  assign(escalation: Escalation, assignment: EscalationAssignment): Promise<void>;
  /**
   * Persist a legal lifecycle transition.
   *
   * @param escalation Updated escalation.
   * @returns A promise fulfilled once the state is durable.
   * @throws {Error} When the underlying storage rejects the write.
   */
  update(escalation: Escalation): Promise<void>;
}
