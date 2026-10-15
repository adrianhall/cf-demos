import { forbidden, notFound, unprocessableContent } from '@adrianhall/cloudflare-toolkit/errors';
import { isAdministrator, type Actor } from '../domain/actor';
import type { AuditRepository } from '../domain/audit';
import type { ConversationRepository, ConversationTurn } from '../domain/conversation';
import { type Escalation, type EscalationRepository, canTransition } from '../domain/escalation';
import type { Faq, FaqRepository } from '../domain/faq';
import type { IndexJobRepository } from '../domain/index-job';

/**
 * Values shared by one escalation action.
 */
export interface EscalationContext {
  /**
   * Verified actor.
   */ actor: Actor;
  /**
   * Correlation ID.
   */ correlationId: string;
  /**
   * Evaluation time.
   */ now: Date;
}
/**
 * Shape accepted by a PM answer form.
 */
export interface AnswerEscalationInput {
  /**
   * Bounded response text.
   */ answer: string;
  /**
   * Whether this answer becomes an FAQ.
   */ publishFaq: boolean;
  /**
   * FAQ audience when publishing.
   */ audience?: Faq['audience'];
  /**
   * Optional FAQ expiry.
   */ expiresAt?: string | null;
}
/**
 * Escalation queue policy and response delivery preparation.
 */
export class EscalationService {
  /**
   * @param escalations Queue persistence. @param conversations Conversation persistence. @param
   *   products Live product scope source. @param faqs FAQ persistence. @param indexJobs Retryable
   *   indexing intents. @param audit Audit trail.
   */
  public constructor(
    private readonly escalations: EscalationRepository,
    private readonly conversations: ConversationRepository,
    private readonly faqs: FaqRepository,
    private readonly indexJobs: IndexJobRepository,
    private readonly audit: AuditRepository
  ) {}
  /**
   * List only the queue entries an actor may manage. @param context Request context. @returns
   * Visible escalations. @throws {ProblemDetailsError} When actor has no queue role.
   */
  public async list(context: EscalationContext): Promise<Escalation[]> {
    if (isAdministrator(context.actor)) return this.escalations.list(null);
    if (context.actor.role !== 'pm' && context.actor.role !== 'overseer')
      throw notFound({ detail: 'Escalation queue not found.' });
    return this.escalations.list(context.actor.productScopes);
  }
  /**
   * Reassign an escalation while preventing any routing cycle. @param context Request context.
   *
   * @param id Escalation ID. @param target New PM display name. @returns Updated escalation.
   * @throws {ProblemDetailsError} When unauthorized, unavailable, invalid, or cyclic.
   */
  public async reassign(
    context: EscalationContext,
    id: string,
    target: string
  ): Promise<Escalation> {
    const escalation = await this.requireManageable(context, id);
    const name = this.name(target);
    const history = await this.escalations.assignments(escalation.id);
    // Refusing every previously assigned target is stronger than merely rejecting an immediate
    // bounce and therefore also blocks A → B → C → A cycles without relying on UI state.
    const priorTargets = new Set(
      history
        .flatMap((entry) => [entry.previousAssignee, entry.currentAssignee])
        .filter((candidate): candidate is string => candidate !== null)
    );
    if (name === escalation.currentAssignee || priorTargets.has(name)) {
      await this.audit.record({
        actorIdentityKey: context.actor.identityKey,
        action: 'escalation.reassign_rejected',
        resource: `escalation:${escalation.id}`,
        reason: 'cycle',
        correlationId: context.correlationId
      });
      throw unprocessableContent({ detail: 'That reassignment would create an assignment cycle.' });
    }
    const updated: Escalation = {
      ...escalation,
      currentAssignee: name,
      status: escalation.status === 'open' ? 'assigned' : escalation.status
    };
    if (updated.status !== 'assigned' && updated.status !== 'open')
      throw unprocessableContent({ detail: 'This escalation can no longer be reassigned.' });
    await this.escalations.assign(updated, {
      id: crypto.randomUUID(),
      escalationId: escalation.id,
      actorIdentityKey: context.actor.identityKey,
      previousAssignee: escalation.currentAssignee,
      currentAssignee: name,
      reason: 'reassigned',
      createdAt: context.now.toISOString()
    });
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'escalation.reassigned',
      resource: `escalation:${escalation.id}`,
      reason: null,
      correlationId: context.correlationId
    });
    return updated;
  }
  /**
   * Write a PM answer, deliver it as a durable web turn, and optionally publish an FAQ. @param
   * context Request context. @param id Escalation ID. @param input PM form fields. @returns Durable
   * delivered answer turn. @throws {ProblemDetailsError} When invalid or unauthorized.
   */
  public async answer(
    context: EscalationContext,
    id: string,
    input: AnswerEscalationInput
  ): Promise<ConversationTurn> {
    const escalation = await this.requireManageable(context, id);
    if (!canTransition(escalation.status, 'answered'))
      throw unprocessableContent({
        detail: 'This escalation cannot be answered in its current state.'
      });
    const answer = this.answerText(input.answer);
    const answered = { ...escalation, status: 'answered' as const };
    await this.escalations.update(answered);
    const turn = await this.conversations.appendTurn(
      {
        conversationId: escalation.conversationId,
        kind: 'answer',
        actorIdentityKey: context.actor.identityKey,
        content: answer,
        citations: [],
        modelId: null,
        gatewayLogId: null,
        correlationId: context.correlationId,
        idempotencyKey: null
      },
      context.now.toISOString()
    );
    const delivered = { ...answered, status: 'delivered' as const };
    await this.escalations.update(delivered);
    await this.conversations.updateClassification(
      escalation.conversationId,
      escalation.productId,
      'open',
      context.now.toISOString()
    );
    if (input.publishFaq) await this.publish(context, escalation, answer, input);
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'escalation.answered',
      resource: `escalation:${id}`,
      reason: input.publishFaq ? 'faq_published' : null,
      correlationId: context.correlationId
    });
    return turn;
  }
  /**
   * Reject an escalation and create its requester-visible rejection turn. @param context Request
   * context. @param id Escalation ID. @param reason Rejection explanation. @returns Durable
   * rejection turn. @throws {ProblemDetailsError} When invalid or unauthorized.
   */
  public async reject(
    context: EscalationContext,
    id: string,
    reason: string
  ): Promise<ConversationTurn> {
    const escalation = await this.requireManageable(context, id);
    if (!canTransition(escalation.status, 'rejected'))
      throw unprocessableContent({
        detail: 'This escalation cannot be rejected in its current state.'
      });
    const text = this.answerText(reason);
    await this.escalations.update({ ...escalation, status: 'rejected' });
    const turn = await this.conversations.appendTurn(
      {
        conversationId: escalation.conversationId,
        kind: 'rejection',
        actorIdentityKey: context.actor.identityKey,
        content: text,
        citations: [],
        modelId: null,
        gatewayLogId: null,
        correlationId: context.correlationId,
        idempotencyKey: null
      },
      context.now.toISOString()
    );
    await this.conversations.updateClassification(
      escalation.conversationId,
      escalation.productId,
      'closed',
      context.now.toISOString()
    );
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'escalation.rejected',
      resource: `escalation:${id}`,
      reason: null,
      correlationId: context.correlationId
    });
    return turn;
  }
  private async requireManageable(context: EscalationContext, id: string): Promise<Escalation> {
    const escalation = await this.escalations.find(id);
    if (escalation === null) throw notFound({ detail: 'Escalation not found.' });
    if (isAdministrator(context.actor)) return escalation;
    if (context.actor.role !== 'pm') throw notFound({ detail: 'Escalation not found.' });
    if (
      escalation.productId === null
      || !context.actor.productScopes.includes(escalation.productId)
    )
      throw forbidden({ detail: 'This escalation is not in your product scope.' });
    return escalation;
  }
  private name(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 120)
      throw unprocessableContent({ detail: 'target must be between 1 and 120 characters.' });
    return trimmed;
  }
  private answerText(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 8_000)
      throw unprocessableContent({ detail: 'response must be between 1 and 8000 characters.' });
    return trimmed;
  }
  private async publish(
    context: EscalationContext,
    escalation: Escalation,
    answer: string,
    input: AnswerEscalationInput
  ): Promise<void> {
    if (input.audience === undefined)
      throw unprocessableContent({ detail: 'audience is required when publishing an FAQ.' });
    const question = await this.conversations
      .listTurns(escalation.conversationId, 200)
      .then((turns) => turns.find((turn) => turn.id === escalation.questionEventId));
    if (question === undefined)
      throw new Error('Escalation question is missing from its conversation.');
    const timestamp = context.now.toISOString();
    const faq: Faq = {
      id: crypto.randomUUID(),
      revision: 1,
      question: question.content,
      answer,
      productId: escalation.productId,
      ownerIdentityKey: context.actor.identityKey,
      audience: input.audience,
      expiresAt:
        input.expiresAt === undefined
          ? new Date(context.now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString()
          : input.expiresAt,
      status: 'active',
      sourceEscalationId: escalation.id,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.faqs.insert(faq);
    await this.indexJobs.enqueue(faq.id, faq.revision, 'upsert');
  }
}
