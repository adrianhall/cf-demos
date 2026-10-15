import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import type { Actor } from '../domain/actor';
import type { AuditRepository } from '../domain/audit';
import {
  ownsConversation,
  type Conversation,
  type ConversationRepository,
  type ConversationTurn
} from '../domain/conversation';
import { validateConversationId } from '../domain/conversation-validation';

/**
 * Request-scoped values every conversation operation shares.
 */
export interface ConversationContext {
  /**
   * Resolved authorization subject.
   */
  actor: Actor;
  /**
   * Correlation identifier shared with the structured logs for this request.
   */
  correlationId: string;
  /**
   * Instant the operation is evaluated at.
   */
  now: Date;
}

/**
 * Largest number of conversations a requester's own list returns.
 */
export const CONVERSATION_LIST_LIMIT = 50;

/**
 * Largest number of turns one transcript replay contains.
 *
 * Bounded so a long-running conversation's replay frame stays a predictable size. The window is
 * generous for a question-and-answer exchange and, unlike the chat demo's message history, is a
 * read bound rather than a retention policy: every turn stays in D1, and Phase 5 makes retention
 * configurable.
 */
export const TRANSCRIPT_LIMIT = 200;

/**
 * Conversation ownership and lifecycle.
 *
 * Every method that touches an existing conversation goes through
 * {@link ConversationService.requireOwned}, which is the single ownership gate for the whole
 * feature. Concentrating it here is deliberate: the Durable Object, the HTTP routes, and the
 * WebSocket upgrade all reach conversations, and an ownership check written separately in each
 * would be three chances to get it wrong.
 */
export class ConversationService {
  /**
   * @param conversations Conversation and turn persistence port.
   * @param audit Audit trail port.
   */
  public constructor(
    private readonly conversations: ConversationRepository,
    private readonly audit: AuditRepository
  ) {}

  /**
   * Start a conversation owned by the verified requester.
   *
   * The owner is taken from the resolved actor and never from the request. There is no parameter to
   * supply one, which is what makes "a requester cannot create a conversation on somebody else's
   * behalf" a property of the signature rather than a validation rule.
   *
   * @param context Actor, correlation identifier, and instant.
   * @returns The created conversation.
   * @throws {Error} When D1 rejects the write.
   */
  public async createConversation(context: ConversationContext): Promise<Conversation> {
    const timestamp = context.now.toISOString();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      channel: 'web',
      requesterIdentityKey: context.actor.identityKey,
      productId: null,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.conversations.create(conversation);
    await this.audit.record({
      actorIdentityKey: context.actor.identityKey,
      action: 'conversation.created',
      resource: `conversation:${conversation.id}`,
      reason: null,
      correlationId: context.correlationId
    });
    return conversation;
  }

  /**
   * List the conversations the requester owns.
   *
   * @param context Actor, correlation identifier, and instant.
   * @returns The requester's conversations, most recently updated first.
   * @throws {Error} When D1 rejects the read.
   */
  public async listConversations(context: ConversationContext): Promise<Conversation[]> {
    return this.conversations.listForRequester(context.actor.identityKey, CONVERSATION_LIST_LIMIT);
  }

  /**
   * Read a conversation the requester owns.
   *
   * @param context Actor, correlation identifier, and instant.
   * @param id Unvalidated identifier from the request path or socket route.
   * @returns The conversation.
   * @throws {ProblemDetailsError} `notFound()` (404) when the identifier is malformed, no
   *   conversation has it, or it belongs to somebody else — all three answer identically, so the
   *   endpoint cannot be used to discover that another person's conversation exists.
   * @throws {Error} When D1 rejects the read.
   */
  public async requireOwned(context: ConversationContext, id: string): Promise<Conversation> {
    const conversation = await this.conversations.find(validateConversationId(id));
    if (conversation === null || !ownsConversation(conversation, context.actor.identityKey)) {
      throw notFound({ detail: 'Conversation not found.' });
    }
    return conversation;
  }

  /**
   * Read a conversation's transcript.
   *
   * @param context Actor, correlation identifier, and instant.
   * @param id Unvalidated identifier from the request path.
   * @returns Turns in sequence order, oldest first.
   * @throws {ProblemDetailsError} `notFound()` (404) when the conversation is unknown or not the
   *   requester's.
   * @throws {Error} When D1 rejects the read.
   */
  public async listTurns(context: ConversationContext, id: string): Promise<ConversationTurn[]> {
    const conversation = await this.requireOwned(context, id);
    return this.conversations.listTurns(conversation.id, TRANSCRIPT_LIMIT);
  }

  /**
   * Record a question, returning the existing turn when the key has already been used.
   *
   * The idempotency key is checked before the insert _and_ a uniqueness violation is caught after
   * it. Both are needed: the pre-check handles the ordinary retry, and the post-check handles two
   * retries racing, where both pre-checks find nothing and one insert loses. Without the second, a
   * double-submitted question would surface as a `500` on a request the product had in fact already
   * handled correctly.
   *
   * @param context Actor, correlation identifier, and instant.
   * @param conversation Conversation the question belongs to, already confirmed owned.
   * @param question Validated question text.
   * @param idempotencyKey Validated client-supplied key.
   * @returns The question turn and whether it was newly created. A replay returns `false`, which is
   *   how the caller knows not to run the answer workflow a second time.
   * @throws {Error} When D1 rejects the write for any reason other than the uniqueness violation.
   */
  public async recordQuestion(
    context: ConversationContext,
    conversation: Conversation,
    question: string,
    idempotencyKey: string
  ): Promise<{ turn: ConversationTurn; created: boolean }> {
    const existing = await this.conversations.findTurnByIdempotencyKey(
      conversation.id,
      idempotencyKey
    );
    if (existing !== null) {
      return { turn: existing, created: false };
    }

    try {
      const turn = await this.conversations.appendTurn(
        {
          conversationId: conversation.id,
          kind: 'question',
          actorIdentityKey: context.actor.identityKey,
          content: question,
          citations: [],
          modelId: null,
          gatewayLogId: null,
          correlationId: context.correlationId,
          idempotencyKey
        },
        context.now.toISOString()
      );
      return { turn, created: true };
    } catch (cause: unknown) {
      const raced = await this.conversations.findTurnByIdempotencyKey(
        conversation.id,
        idempotencyKey
      );
      if (raced === null) {
        throw cause;
      }
      return { turn: raced, created: false };
    }
  }
}
