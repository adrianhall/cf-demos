import type { Logger } from '@adrianhall/cloudflare-toolkit/logging';
import type { Actor } from '../domain/actor';
import {
  assessEvidence,
  parseDecisionVerdict,
  type AnswerDecision,
  type EscalationReason
} from '../domain/answer-decision';
import type { AuditRepository } from '../domain/audit';
import {
  toCitation,
  type Citation,
  type Conversation,
  type ConversationRepository,
  type ConversationTurn,
  type Evidence
} from '../domain/conversation';
import type { Escalation, EscalationRepository } from '../domain/escalation';
import type { InferencePort } from '../domain/inference';
import { ANSWER_MODEL, DECISION_MODEL } from '../domain/models';
import { escalationTargetFor, type ProductRepository } from '../domain/product';
import {
  ANSWER_SYSTEM_PROMPT,
  DECISION_SYSTEM_PROMPT,
  buildAnswerPrompt,
  buildDecisionPrompt
} from './answer-prompts';
import type { RetrievalService } from './retrieval-service';

/**
 * Message shown when a question is routed to a person.
 *
 * A fixed, reviewed string rather than model output. The acknowledgement is the product speaking in
 * its own voice about its own limits, and generating it would mean a model deciding how to describe
 * a failure to answer — which is the one moment the product most needs to be predictable.
 */
export const ESCALATION_ACKNOWLEDGEMENT =
  'I do not have approved material that answers this, so I have sent it to the product manager '
  + 'responsible. You will see their reply in this conversation.';

/**
 * Message shown when a question is escalated because the only matching knowledge is restricted.
 *
 * Deliberately does not say _what_ was found or that anything was found at all. Telling a requester
 * "there is an NDA-only answer to this" is itself a disclosure about restricted material, and the
 * person it would help is the one person who should not be told.
 */
export const RESTRICTED_ACKNOWLEDGEMENT =
  'I cannot answer this from the material available to you, so I have sent it to the product '
  + 'manager responsible. You will see their reply in this conversation.';

/**
 * What the workflow produced for one question.
 *
 * A discriminated union so a caller cannot read an answer turn from an escalation outcome. Both
 * carry the persisted turn, because in both cases something durable was written and broadcast — the
 * difference is whether an escalation was opened alongside it.
 */
export type AnswerOutcome =
  | {
      /**
       * Discriminator: the question was answered.
       */
      outcome: 'answered';
      /**
       * The persisted answer turn, with its citations.
       */
      turn: ConversationTurn;
    }
  | {
      /**
       * Discriminator: the question went to a person.
       */
      outcome: 'escalated';
      /**
       * The persisted acknowledgement turn.
       */
      turn: ConversationTurn;
      /**
       * The escalation that is now in the queue.
       */
      escalation: Escalation;
      /**
       * Why it was escalated.
       */
      reason: EscalationReason;
    };

/**
 * Request-scoped values the workflow shares.
 */
export interface AnswerContext {
  /**
   * Resolved authorization subject, supplying the identity key and clearance.
   */
  actor: Actor;
  /**
   * Correlation identifier shared by every log line, audit entry, gateway log, and stored turn for
   * this request.
   */
  correlationId: string;
  /**
   * Instant the operation is evaluated at, so retrieval expiry, the delivery recheck, and the turn
   * timestamps all agree within one request.
   */
  now: Date;
  /**
   * Signal that abandons generation when the requester cancels or disconnects.
   */
  signal?: AbortSignal;
}

/**
 * How a stage of the workflow reports progress.
 *
 * A callback rather than a return value because the stages are useful while they are happening: the
 * browser shows "retrieving" and then "generating" during the seconds a model takes. The service
 * does not know it is talking to a WebSocket, which is what keeps it usable from an HTTP route and
 * from a post-MVP channel adapter unchanged.
 */
export type StageReporter = (
  stage: 'retrieving' | 'deciding' | 'generating' | 'escalating'
) => void;

/**
 * The shared answer workflow.
 *
 * This is the single implementation of the specification's agent loop, and every channel reaches
 * it: the web chat Durable Object calls it on each question, and the post-MVP email and Google Chat
 * adapters are expected to normalize their events and call exactly this. There is no second
 * retrieval path, no second escalation rule, and no second place a model is called from — which is
 * what makes "every channel behaves the same" a structural property rather than a convention.
 *
 * The order of operations is the specification's, and each step's position is load-bearing:
 *
 * 1. Retrieve candidates, filtered by the requester's clearance.
 * 2. Recheck every candidate against D1 — expiry, status, current audience.
 * 3. Assess the evidence **deterministically**. This decides the escalation boundary, not the model.
 * 4. Ask the decision model whether the evidence addresses the question. It may only narrow step 3.
 * 5. Generate the answer from bounded evidence, or open an escalation.
 * 6. Re-apply the audience filter immediately before delivery.
 * 7. Persist the turn, and only then let the caller broadcast it.
 *
 * Step 7 is why this service returns a persisted turn rather than taking a broadcast callback: a
 * caller physically cannot broadcast before the write, because it has nothing to broadcast until
 * the write returns.
 */
export class AnswerService {
  /**
   * @param retrieval Retrieval with the D1 policy recheck applied.
   * @param inference Gateway-routed model client. The only way this service reaches a model.
   * @param conversations Conversation and turn persistence port.
   * @param escalations Escalation persistence port.
   * @param products Product map, read to resolve an escalation's assignee.
   * @param audit Audit trail port.
   * @param logger Structured logger for operation records.
   */
  public constructor(
    private readonly retrieval: RetrievalService,
    private readonly inference: InferencePort,
    private readonly conversations: ConversationRepository,
    private readonly escalations: EscalationRepository,
    private readonly products: ProductRepository,
    private readonly audit: AuditRepository,
    private readonly logger?: Logger
  ) {}

  /**
   * Answer one question, or route it to a person.
   *
   * @param context Actor, correlation identifier, instant, and cancellation signal.
   * @param conversation Conversation the question was asked in. Ownership has already been checked
   *   by the caller; this service is reached only through one that did.
   * @param questionTurn The already-persisted question turn, which the escalation is keyed by.
   * @param reportStage Progress callback; see {@link StageReporter}.
   * @returns The persisted answer or acknowledgement turn, and the escalation when one was opened.
   * @throws {ProblemDetailsError} `502` when the answer model fails, after the question is already
   *   durable — so a retry re-answers an existing question rather than losing it.
   * @throws {Error} When D1 rejects a read or write. An `AbortError` propagates unchanged when the
   *   requester cancels, and nothing is persisted for the abandoned answer.
   */
  public async answer(
    context: AnswerContext,
    conversation: Conversation,
    questionTurn: ConversationTurn,
    reportStage: StageReporter
  ): Promise<AnswerOutcome> {
    reportStage('retrieving');
    const decision = await this.decide(context, conversation, questionTurn);

    if (decision.outcome === 'escalate') {
      reportStage('escalating');
      return this.escalate(context, conversation, questionTurn, decision.reason);
    }

    reportStage('generating');
    const generated = await this.inference.generate({
      model: ANSWER_MODEL,
      system: ANSWER_SYSTEM_PROMPT,
      prompt: buildAnswerPrompt(questionTurn.content, decision.evidence),
      conversationId: conversation.id,
      correlationId: context.correlationId,
      actor: { email: context.actor.email, identityKey: context.actor.identityKey },
      ...(context.signal === undefined ? {} : { signal: context.signal })
    });

    // The delivery-time recheck. A clearance can be lowered or an FAQ reclassified during the
    // seconds a 70B model takes, and an answer that was authorized when it was written is not
    // necessarily authorized when it is shown.
    const permitted = await this.retrieval.filterForDelivery(
      context.actor,
      decision.evidence,
      context.now
    );
    if (permitted.length === 0) {
      // Every source the answer was grounded in has become unreadable to this requester. The
      // generated text quotes those sources, so it cannot be delivered — the question goes to a
      // person instead, under the reason that describes exactly what happened.
      this.logger?.warn('answer_withheld_after_delivery_filter', {
        conversationId: conversation.id,
        correlationId: context.correlationId,
        questionTurnId: questionTurn.id,
        generatedLength: generated.text.length
      });
      reportStage('escalating');
      return this.escalate(context, conversation, questionTurn, 'restricted_evidence');
    }

    const turn = await this.conversations.appendTurn(
      {
        conversationId: conversation.id,
        kind: 'answer',
        actorIdentityKey: null,
        content: generated.text,
        citations: permitted.map(toCitation),
        modelId: ANSWER_MODEL.id,
        gatewayLogId: generated.logId ?? null,
        correlationId: context.correlationId,
        idempotencyKey: null
      },
      context.now.toISOString()
    );

    // Identifiers, counts, and durations only. The question, the evidence, and the answer are all
    // content the specification forbids in routine logs; the gateway log identifier is the thread
    // that ties this line to the model call's own record.
    this.logger?.info('conversation_answered', {
      conversationId: conversation.id,
      correlationId: context.correlationId,
      turnId: turn.id,
      sequence: turn.sequence,
      model: ANSWER_MODEL.id,
      gatewayLogId: generated.logId ?? null,
      citationCount: permitted.length,
      answerLength: generated.text.length,
      elapsedMs: generated.elapsedMs
    });
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'conversation.answered',
      resource: `conversation:${conversation.id}`,
      reason: `citations=${permitted.length}`,
      correlationId: context.correlationId
    });

    return { outcome: 'answered', turn };
  }

  /**
   * Open an escalation for a question the requester explicitly asked a person to handle.
   *
   * Separate from the workflow's own escalation so the recorded reason differs: an operator reading
   * the queue needs to tell "the product could not answer" from "the salesperson wanted a human",
   * because the two say different things about the knowledge base.
   *
   * @param context Actor, correlation identifier, and instant.
   * @param conversation Conversation to escalate.
   * @param questionTurn Question the escalation is keyed by.
   * @returns The persisted acknowledgement turn and the escalation.
   * @throws {Error} When D1 rejects a read or write.
   */
  public async escalateOnRequest(
    context: AnswerContext,
    conversation: Conversation,
    questionTurn: ConversationTurn
  ): Promise<AnswerOutcome> {
    return this.escalate(context, conversation, questionTurn, 'requested');
  }

  /**
   * Retrieve, recheck, and decide whether to answer.
   *
   * A retrieval failure escalates rather than propagating. That is a deliberate policy choice: when
   * the index is unreachable the product genuinely cannot answer, and routing the question to a
   * person is more useful to a salesperson than an error — they still get an answer, just a slower
   * one.
   *
   * @param context Actor, correlation identifier, instant, and signal.
   * @param conversation Conversation being handled.
   * @param questionTurn The question to decide on.
   * @returns The decision, with bounded evidence when it is to answer.
   * @throws {Error} When D1 rejects a read during the recheck, which is a genuine fault rather than
   *   an absence of evidence.
   */
  private async decide(
    context: AnswerContext,
    conversation: Conversation,
    questionTurn: ConversationTurn
  ): Promise<AnswerDecision> {
    let retrieved;
    try {
      retrieved = await this.retrieval.retrieve(context.actor, questionTurn.content, context.now);
    } catch (cause: unknown) {
      this.logger?.error('retrieval_failed', {
        conversationId: conversation.id,
        correlationId: context.correlationId,
        questionTurnId: questionTurn.id,
        errorMessage: cause instanceof Error ? cause.message : 'unknown'
      });
      return { outcome: 'escalate', reason: 'insufficient_evidence' };
    }

    this.logger?.info('retrieval_completed', {
      conversationId: conversation.id,
      correlationId: context.correlationId,
      evidenceCount: retrieved.evidence.length,
      restrictedMatches: retrieved.restrictedMatches,
      staleMatches: retrieved.staleMatches
    });

    const assessment = assessEvidence(retrieved.evidence, retrieved.restrictedMatches);
    if (assessment.outcome === 'escalate') {
      return assessment;
    }

    const verdict = await this.consultDecisionModel(
      context,
      conversation,
      questionTurn.content,
      assessment.evidence
    );
    if (!verdict.grounded) {
      // The model may only ever narrow the deterministic assessment: it can turn an answer into an
      // escalation, never an escalation into an answer. That asymmetry is what keeps the model from
      // being load-bearing for safety.
      return { outcome: 'escalate', reason: 'insufficient_evidence' };
    }
    return assessment;
  }

  /**
   * Ask the decision model whether the evidence addresses the question.
   *
   * A failure of _this_ call is treated as not grounded, which escalates. The alternative —
   * treating an unreachable judge as approval — would mean a provider outage silently removed the
   * check, which is the opposite of what a safety step should do under failure.
   *
   * @param context Actor, correlation identifier, and signal.
   * @param conversation Conversation being handled.
   * @param question The requester's validated question.
   * @param evidence Bounded evidence under consideration.
   * @returns The parsed verdict.
   * @throws {Error} When the requester cancels, so the whole workflow is abandoned rather than
   *   being converted into an escalation they did not ask for.
   */
  private async consultDecisionModel(
    context: AnswerContext,
    conversation: Conversation,
    question: string,
    evidence: Evidence[]
  ): Promise<{ grounded: boolean; reasonCode: string | null }> {
    try {
      const result = await this.inference.generate({
        model: DECISION_MODEL,
        system: DECISION_SYSTEM_PROMPT,
        prompt: buildDecisionPrompt(question, evidence),
        conversationId: conversation.id,
        correlationId: context.correlationId,
        actor: { email: context.actor.email, identityKey: context.actor.identityKey },
        ...(context.signal === undefined ? {} : { signal: context.signal })
      });
      const verdict = parseDecisionVerdict(result.text);
      this.logger?.info('decision_completed', {
        conversationId: conversation.id,
        correlationId: context.correlationId,
        model: DECISION_MODEL.id,
        gatewayLogId: result.logId ?? null,
        grounded: verdict.grounded,
        reasonCode: verdict.reasonCode,
        elapsedMs: result.elapsedMs
      });
      return verdict;
    } catch (cause: unknown) {
      // A cancellation is the requester's own doing and must abandon the whole workflow rather than
      // being converted into an escalation they did not ask for.
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw cause;
      }
      this.logger?.error('decision_failed', {
        conversationId: conversation.id,
        correlationId: context.correlationId,
        model: DECISION_MODEL.id,
        errorMessage: cause instanceof Error ? cause.message : 'unknown'
      });
      return { grounded: false, reasonCode: 'decision_unavailable' };
    }
  }

  /**
   * Open an escalation and persist its acknowledgement.
   *
   * The escalation is opened **before** the acknowledgement turn is written, and that order
   * matters: the turn tells the requester a person is looking at their question, so writing it
   * first would mean a failure between the two leaves a promise nobody is keeping. Opening first
   * can at worst leave a queue entry whose acknowledgement did not reach the browser — and a
   * reconnect replays the transcript, where it is not; that is a visible, recoverable state rather
   * than a silent one.
   *
   * @param context Actor, correlation identifier, and instant.
   * @param conversation Conversation being escalated.
   * @param questionTurn Question the escalation is keyed by, making it idempotent.
   * @param reason Why the escalation was opened.
   * @returns The persisted acknowledgement turn and the escalation.
   * @throws {Error} When D1 rejects a read or write.
   */
  private async escalate(
    context: AnswerContext,
    conversation: Conversation,
    questionTurn: ConversationTurn,
    reason: EscalationReason
  ): Promise<AnswerOutcome> {
    const product =
      conversation.productId === null ? null : await this.products.find(conversation.productId);

    const initialTarget = escalationTargetFor(product);
    const escalation = await this.escalations.open({
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      questionEventId: questionTurn.id,
      productId: conversation.productId,
      // An unlisted product still has to reach somebody; the product map's default target is who.
      currentAssignee: initialTarget,
      reason,
      status: 'open',
      openedAt: context.now.toISOString()
    });
    // The initial automatic routing is history too: otherwise the first manual reassignment could
    // bounce directly back to the seeded target without the cycle rule seeing it.
    if ((await this.escalations.assignments(escalation.id)).length === 0) {
      await this.escalations.assign(
        { ...escalation, status: 'assigned' },
        {
          id: crypto.randomUUID(),
          escalationId: escalation.id,
          actorIdentityKey: null,
          previousAssignee: null,
          currentAssignee: initialTarget,
          reason: 'product_map',
          createdAt: context.now.toISOString()
        }
      );
    }

    await this.conversations.updateClassification(
      conversation.id,
      conversation.productId,
      'escalated',
      context.now.toISOString()
    );

    const turn = await this.conversations.appendTurn(
      {
        conversationId: conversation.id,
        kind: 'escalation_ack',
        actorIdentityKey: null,
        content:
          reason === 'restricted_evidence'
            ? RESTRICTED_ACKNOWLEDGEMENT
            : ESCALATION_ACKNOWLEDGEMENT,
        citations: [],
        modelId: null,
        gatewayLogId: null,
        correlationId: context.correlationId,
        idempotencyKey: null
      },
      context.now.toISOString()
    );

    this.logger?.info('conversation_escalated', {
      conversationId: conversation.id,
      correlationId: context.correlationId,
      escalationId: escalation.id,
      questionTurnId: questionTurn.id,
      reason,
      productId: conversation.productId
    });
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'escalation.opened',
      resource: `escalation:${escalation.id}`,
      reason,
      correlationId: context.correlationId
    });

    return { outcome: 'escalated', turn, escalation, reason };
  }
}

/**
 * Citation shape re-exported for the route and transport layers, so neither has to reach into the
 * domain for a type it only uses to shape a response.
 */
export type { Citation };
