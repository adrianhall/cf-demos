import type {
  AppendTurnInput,
  Citation,
  Conversation,
  ConversationRepository,
  ConversationStatus,
  ConversationTurn,
  TurnKind
} from '../domain/conversation';

interface ConversationRow {
  id: string;
  channel: 'web';
  requester_identity_key: string;
  product_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  sequence: number;
  kind: string;
  actor_identity_key: string | null;
  content_text: string | null;
  citations: string | null;
  model_id: string | null;
  correlation_id: string;
  created_at: string;
}

function toStatus(value: string): ConversationStatus {
  return value === 'escalated' || value === 'closed' ? value : 'open';
}

function toKind(value: string): TurnKind {
  return value === 'answer' || value === 'escalation_ack' || value === 'rejection'
    ? value
    : 'question';
}

function parseCitations(value: string | null): Citation[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Citation =>
        typeof item === 'object'
        && item !== null
        && ((item as Record<string, unknown>).sourceType === 'faq'
          || (item as Record<string, unknown>).sourceType === 'documentation')
        && typeof (item as Record<string, unknown>).reference === 'string'
        && typeof (item as Record<string, unknown>).title === 'string'
    );
  } catch {
    return [];
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    channel: row.channel,
    requesterIdentityKey: row.requester_identity_key,
    productId: row.product_id,
    status: toStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTurn(row: TurnRow): ConversationTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    kind: toKind(row.kind),
    actorIdentityKey: row.actor_identity_key,
    content: row.content_text ?? '',
    citations: parseCitations(row.citations),
    modelId: row.model_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at
  };
}

/**
 * D1 implementation of the authoritative conversation and transcript store.
 */
export class D1ConversationRepository implements ConversationRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}

  /**
   * Create one conversation.
   */
  public async create(conversation: Conversation): Promise<void> {
    await this.database
      .prepare(
        'INSERT INTO conversations (id, channel, requester_identity_key, product_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
      )
      .bind(
        conversation.id,
        conversation.channel,
        conversation.requesterIdentityKey,
        conversation.productId,
        conversation.status,
        conversation.createdAt,
        conversation.updatedAt
      )
      .run();
  }

  /**
   * Read one conversation.
   */
  public async find(id: string): Promise<Conversation | null> {
    const row = await this.database
      .prepare(
        'SELECT id, channel, requester_identity_key, product_id, status, created_at, updated_at FROM conversations WHERE id = ?1'
      )
      .bind(id)
      .first<ConversationRow>();
    return row === null ? null : toConversation(row);
  }

  /**
   * List a requester's conversations.
   */
  public async listForRequester(
    requesterIdentityKey: string,
    limit: number
  ): Promise<Conversation[]> {
    const rows = await this.database
      .prepare(
        'SELECT id, channel, requester_identity_key, product_id, status, created_at, updated_at FROM conversations WHERE requester_identity_key = ?1 ORDER BY updated_at DESC LIMIT ?2'
      )
      .bind(requesterIdentityKey, limit)
      .all<ConversationRow>();
    return rows.results.map(toConversation);
  }

  /**
   * Append an ordered turn and update the parent conversation in one D1 batch.
   */
  public async appendTurn(input: AppendTurnInput, now: string): Promise<ConversationTurn> {
    const id = crypto.randomUUID();
    const sequenceRow = await this.database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM conversation_events WHERE conversation_id = ?1'
      )
      .bind(input.conversationId)
      .first<{ next_sequence: number }>();
    const sequence = sequenceRow?.next_sequence ?? 1;
    await this.database.batch([
      this.database
        .prepare(
          'INSERT INTO conversation_events (id, conversation_id, actor_identity_key, visibility, content_reference, content_hash, delivery_state, correlation_id, created_at, kind, sequence, content_text, citations, model_id, gateway_log_id, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)'
        )
        .bind(
          id,
          input.conversationId,
          input.actorIdentityKey,
          'requester',
          `d1:${id}`,
          await hash(input.content),
          'persisted',
          input.correlationId,
          now,
          input.kind,
          sequence,
          input.content,
          JSON.stringify(input.citations),
          input.modelId,
          input.gatewayLogId,
          input.idempotencyKey
        ),
      this.database
        .prepare('UPDATE conversations SET updated_at = ?2 WHERE id = ?1')
        .bind(input.conversationId, now)
    ]);
    return {
      id,
      conversationId: input.conversationId,
      sequence,
      kind: input.kind,
      actorIdentityKey: input.actorIdentityKey,
      content: input.content,
      citations: input.citations,
      modelId: input.modelId,
      correlationId: input.correlationId,
      createdAt: now
    };
  }

  /**
   * Find a replayed client submission.
   */
  public async findTurnByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string
  ): Promise<ConversationTurn | null> {
    const row = await this.database
      .prepare(
        'SELECT id, conversation_id, sequence, kind, actor_identity_key, content_text, citations, model_id, correlation_id, created_at FROM conversation_events WHERE conversation_id = ?1 AND idempotency_key = ?2'
      )
      .bind(conversationId, idempotencyKey)
      .first<TurnRow>();
    return row === null ? null : toTurn(row);
  }

  /**
   * Read the most recent bounded transcript in forward order.
   */
  public async listTurns(conversationId: string, limit: number): Promise<ConversationTurn[]> {
    const rows = await this.database
      .prepare(
        'SELECT id, conversation_id, sequence, kind, actor_identity_key, content_text, citations, model_id, correlation_id, created_at FROM conversation_events WHERE conversation_id = ?1 ORDER BY sequence DESC LIMIT ?2'
      )
      .bind(conversationId, limit)
      .all<TurnRow>();
    return rows.results.reverse().map(toTurn);
  }

  /**
   * Update classification and lifecycle status.
   */
  public async updateClassification(
    id: string,
    productId: string | null,
    status: ConversationStatus,
    now: string
  ): Promise<void> {
    await this.database
      .prepare(
        'UPDATE conversations SET product_id = ?2, status = ?3, updated_at = ?4 WHERE id = ?1'
      )
      .bind(id, productId, status, now)
      .run();
  }
}

/**
 * Computes the content reference hash without retaining any additional content.
 */
async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
