import type { Audience } from './audience';

/**
 * Channel a conversation arrived over.
 *
 * Only `web` exists in the MVP. The column already carries a `CHECK` constraint for it, and the
 * type is a union of one rather than a bare string so that adding the post-MVP email and Google
 * Chat channels fails the build everywhere a channel is handled, instead of silently falling
 * through a `switch` somewhere.
 */
export type ConversationChannel = 'web';

/**
 * Lifecycle of a conversation.
 *
 * `escalated` is distinct from `open` because the two differ in what the product will do next: an
 * open conversation answers the next question itself, while an escalated one is waiting for a
 * person. Phase 4 transitions an escalated conversation back to `open` when a PM responds.
 */
export type ConversationStatus = 'open' | 'escalated' | 'closed';

/**
 * What a turn is.
 *
 * Mirrors the `conversation_events.kind` column. An `escalation_ack` and a `rejection` are both
 * product-authored turns with no citations, kept apart because a reader must be able to tell "a
 * person is looking at this" from "nobody will answer this".
 */
export type TurnKind = 'question' | 'answer' | 'escalation_ack' | 'rejection';

/**
 * Where a citation points.
 */
export type CitationSourceType = 'faq' | 'documentation';

/**
 * One source an answer was grounded in.
 *
 * Citations are the demonstration's central honesty mechanism: an answer a salesperson cannot trace
 * is an answer they should not repeat to a customer. The shape carries a reference and a title and
 * never the quoted text, so rendering a citation cannot leak a passage from a source the reader is
 * not cleared for even if the retrieval filter were later weakened.
 */
export interface Citation {
  /**
   * Whether the source is a published FAQ or an approved documentation page.
   */
  sourceType: CitationSourceType;
  /**
   * Stable reference: the FAQ identifier, or the manifest path of the documentation page.
   */
  reference: string;
  /**
   * Human-readable label shown next to the answer.
   */
  title: string;
}

/**
 * One conversation between a verified requester and the product.
 */
export interface Conversation {
  /**
   * Stable conversation identifier, also the Durable Object's name.
   */
  id: string;
  /**
   * Channel the conversation arrived over.
   */
  channel: ConversationChannel;
  /**
   * Verified identity key of the person who owns this conversation. Nothing in a request can change
   * it, and it is what every ownership check compares against.
   */
  requesterIdentityKey: string;
  /**
   * Product the conversation is about, or `null` before it has been classified.
   */
  productId: string | null;
  /**
   * Lifecycle state.
   */
  status: ConversationStatus;
  /**
   * ISO-8601 instant the conversation was created.
   */
  createdAt: string;
  /**
   * ISO-8601 instant of the most recent turn.
   */
  updatedAt: string;
}

/**
 * One durable turn in a conversation.
 *
 * Append-only: a turn is never edited, so a transcript a reader saw is a transcript they can see
 * again. This is the shape that crosses the WebSocket to the browser (see `src/chat-protocol.ts`),
 * which is why it carries no clearance, prompt, or provider payload.
 */
export interface ConversationTurn {
  /**
   * Generated turn identifier.
   */
  id: string;
  /**
   * Conversation this turn belongs to.
   */
  conversationId: string;
  /**
   * Position within the conversation, assigned by the session that owns ordering. Monotonic from 1.
   */
  sequence: number;
  /**
   * What kind of turn this is.
   */
  kind: TurnKind;
  /**
   * Verified identity key of the author, or `null` for a turn the product authored.
   */
  actorIdentityKey: string | null;
  /**
   * The turn's text.
   */
  content: string;
  /**
   * Sources backing an answer. Empty for every other kind.
   */
  citations: Citation[];
  /**
   * Reviewed model that produced this turn, or `null` when no model was involved.
   */
  modelId: string | null;
  /**
   * Correlation identifier shared with the structured logs and audit entries for the request that
   * produced this turn.
   */
  correlationId: string;
  /**
   * ISO-8601 instant the turn was persisted.
   */
  createdAt: string;
}

/**
 * What the application supplies when appending a turn.
 *
 * The identifier, sequence number, and timestamp are the repository's to assign, so a caller cannot
 * backdate a turn or claim a position in the order.
 */
export interface AppendTurnInput {
  /**
   * Conversation to append to.
   */
  conversationId: string;
  /**
   * What kind of turn this is.
   */
  kind: TurnKind;
  /**
   * Verified identity key of the author, or `null` for a product-authored turn.
   */
  actorIdentityKey: string | null;
  /**
   * The turn's validated text.
   */
  content: string;
  /**
   * Sources backing an answer.
   */
  citations: Citation[];
  /**
   * Reviewed model that produced the turn, or `null`.
   */
  modelId: string | null;
  /**
   * AI Gateway log identifier for the generating call, or `null` when the gateway assigned none.
   */
  gatewayLogId: string | null;
  /**
   * Correlation identifier for the request that produced this turn.
   */
  correlationId: string;
  /**
   * Client-supplied idempotency key, for a question only.
   */
  idempotencyKey: string | null;
}

/**
 * Answer whether an actor may read and write a conversation.
 *
 * Deliberately _only_ the requester, even for an administrator. A conversation is a person's own
 * working transcript rather than a management resource, and an administrator who needs to see one
 * reaches it through the escalation queue in Phase 4 — where the evidence shown is filtered by what
 * that PM is authorized to see. Letting a role read any transcript directly would make the audience
 * filter on retrieval pointless, because every restricted answer ever generated would be readable
 * through the conversation that produced it.
 *
 * @param conversation Conversation being accessed.
 * @param identityKey Verified identity key of the actor, from the Access identity and D1.
 * @returns Whether the actor owns this conversation.
 */
export function ownsConversation(
  conversation: Pick<Conversation, 'requesterIdentityKey'>,
  identityKey: string
): boolean {
  return conversation.requesterIdentityKey === identityKey;
}

/**
 * Persistence port for conversations and their turns.
 *
 * As with every port here, the methods take already-authorized input: authorization is an
 * application decision (`../application/conversation-service.ts`), never a repository one.
 */
export interface ConversationRepository {
  /**
   * Create a conversation owned by a verified requester.
   *
   * @param conversation Fully resolved conversation, including its generated identifier.
   * @returns A promise fulfilled once the conversation is durable.
   * @throws {Error} When the underlying storage rejects the write.
   */
  create(conversation: Conversation): Promise<void>;

  /**
   * Read one conversation.
   *
   * @param id Conversation identifier.
   * @returns The conversation, or `null` when no conversation has that identifier.
   * @throws {Error} When the underlying storage rejects the read.
   */
  find(id: string): Promise<Conversation | null>;

  /**
   * List the conversations a requester owns, most recently updated first.
   *
   * @param requesterIdentityKey Verified identity key of the owner.
   * @param limit Largest number of conversations to return.
   * @returns The requester's conversations.
   * @throws {Error} When the underlying storage rejects the read.
   */
  listForRequester(requesterIdentityKey: string, limit: number): Promise<Conversation[]>;

  /**
   * Append one turn, assigning it the next sequence number.
   *
   * The sequence is assigned inside the repository, in the same statement that inserts the row, so
   * two turns cannot be given the same position. The unique index on `(conversation_id, sequence)`
   * is what makes that a guarantee rather than an intention.
   *
   * @param input Turn to append.
   * @param now ISO-8601 instant to record.
   * @returns The stored turn, including its assigned sequence number.
   * @throws {Error} When the underlying storage rejects the write, including the uniqueness
   *   violation a replayed idempotency key produces.
   */
  appendTurn(input: AppendTurnInput, now: string): Promise<ConversationTurn>;

  /**
   * Read a turn previously stored under an idempotency key.
   *
   * This is how a retried submission returns the original turn instead of failing: the caller looks
   * the key up first, and falls back to this after a uniqueness violation when two retries race.
   *
   * @param conversationId Conversation the key is scoped to.
   * @param idempotencyKey Client-supplied key.
   * @returns The existing turn, or `null` when the key has not been used.
   * @throws {Error} When the underlying storage rejects the read.
   */
  findTurnByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string
  ): Promise<ConversationTurn | null>;

  /**
   * Read a conversation's turns in sequence order.
   *
   * @param conversationId Conversation to read.
   * @param limit Largest number of turns to return, newest kept.
   * @returns Turns in ascending sequence order.
   * @throws {Error} When the underlying storage rejects the read.
   */
  listTurns(conversationId: string, limit: number): Promise<ConversationTurn[]>;

  /**
   * Record a conversation's product classification and status.
   *
   * @param id Conversation identifier.
   * @param productId Classified product, or `null` when classification found none.
   * @param status Lifecycle state to record.
   * @param now ISO-8601 instant to record as the update time.
   * @returns A promise fulfilled once the change is durable.
   * @throws {Error} When the underlying storage rejects the write.
   */
  updateClassification(
    id: string,
    productId: string | null,
    status: ConversationStatus,
    now: string
  ): Promise<void>;
}

/**
 * One retrieved piece of evidence, after the audience and expiry filter has been applied.
 *
 * Produced by the retrieval service and consumed by the decision and answer models. It carries the
 * audience it was classified at so a log can record _that_ a restricted source was excluded without
 * recording what it said.
 */
export interface Evidence {
  /**
   * Where this evidence came from.
   */
  sourceType: CitationSourceType;
  /**
   * Stable reference: the FAQ identifier, or the documentation manifest path.
   */
  reference: string;
  /**
   * Human-readable label.
   */
  title: string;
  /**
   * The passage the model may ground an answer in.
   */
  content: string;
  /**
   * Audience the source is classified at. Documentation is treated as `public`.
   */
  audience: Audience;
  /**
   * Retrieval score, used only for ordering and for a bounded-prompt decision.
   */
  score: number;
}

/**
 * Project retrieved evidence into the citation shown beside an answer.
 *
 * The content is dropped deliberately: a citation is a pointer, and carrying the passage into the
 * stored turn would duplicate source text into the transcript, where no audience filter would ever
 * re-evaluate it.
 *
 * @param evidence Evidence the answer was grounded in.
 * @returns The citation to store and display.
 */
export function toCitation(evidence: Evidence): Citation {
  return {
    sourceType: evidence.sourceType,
    reference: evidence.reference,
    title: evidence.title
  };
}
