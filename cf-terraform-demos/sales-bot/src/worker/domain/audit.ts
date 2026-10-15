/**
 * Actions recorded in the audit trail by the knowledge base.
 *
 * A closed list rather than free text: an audit view that has to cope with arbitrary strings cannot
 * offer a reliable filter, and a typo in an action name would silently create a category nobody
 * ever looks at. Later phases extend this list as they add operations.
 */
export const AUDIT_ACTIONS = [
  'faq.published',
  'faq.revised',
  'faq.archived',
  'faq.deleted',
  'faq.expired',
  'documentation.imported',
  'documentation.indexed',
  'documentation.index_failed',
  'conversation.created',
  'conversation.answered',
  'escalation.opened',
  'escalation.reassign_rejected',
  'escalation.reassigned',
  'escalation.answered',
  'escalation.rejected'
] as const;

/**
 * One recorded action name.
 */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Narrow an untrusted value — most often an audit filter from a query string — to an
 * {@link AuditAction}.
 *
 * @param value Candidate action name.
 * @returns Whether the value is a recognized action.
 */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * One recorded administrative action.
 *
 * The record deliberately carries no content. Question text, answer text, and prompts are exactly
 * the material the specification forbids in retained logs; an audit entry answers who changed what,
 * when, and why, and the changed revision itself is already durable in `faqs`.
 */
export interface AuditEvent {
  /**
   * Generated event identifier.
   */
  id: string;
  /**
   * Verified identity key of the actor, or `null` for an action taken by scheduled maintenance
   * rather than by a person.
   */
  actorIdentityKey: string | null;
  /**
   * What happened.
   */
  action: AuditAction;
  /**
   * Resource the action applied to, as a stable `type:id` reference such as `faq:<uuid>`.
   */
  resource: string;
  /**
   * Short reason code or operator-supplied justification, or `null`. Never free-form content.
   */
  reason: string | null;
  /**
   * Correlation identifier shared with the structured logs for the same request.
   */
  correlationId: string;
  /**
   * ISO-8601 instant the action was recorded.
   */
  createdAt: string;
}

/**
 * What an application service supplies when recording an action. The identifier and timestamp are
 * the repository's to assign, so a caller cannot backdate an entry.
 */
export type AuditEventInput = Omit<AuditEvent, 'id' | 'createdAt'>;

/**
 * Filter applied when an administrator reads the audit trail.
 */
export interface AuditQuery {
  /**
   * Restrict to one action.
   */
  action?: AuditAction;
  /**
   * Restrict to one resource reference.
   */
  resource?: string;
  /**
   * Largest number of entries to return.
   */
  limit: number;
}

/**
 * Persistence port for the audit trail.
 */
export interface AuditRepository {
  /**
   * Append one entry.
   *
   * @param input Action to record.
   * @returns The stored entry, including its generated identifier and timestamp.
   * @throws {Error} When the underlying storage rejects the write.
   */
  record(input: AuditEventInput): Promise<AuditEvent>;

  /**
   * Read recent entries, newest first.
   *
   * @param query Action/resource filter and result limit.
   * @returns Matching entries.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(query: AuditQuery): Promise<AuditEvent[]>;
}
