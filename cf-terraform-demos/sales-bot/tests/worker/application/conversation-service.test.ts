import { describe, expect, it } from 'vitest';
import { ConversationService } from '../../../src/worker/application/conversation-service';
import type { AuditRepository } from '../../../src/worker/domain/audit';
import type {
  AppendTurnInput,
  Conversation,
  ConversationRepository,
  ConversationTurn
} from '../../../src/worker/domain/conversation';
import { actorOf } from '../support/actors';

class MemoryConversations implements ConversationRepository {
  public readonly conversations: Conversation[] = [];
  public readonly turns: ConversationTurn[] = [];
  public async create(conversation: Conversation): Promise<void> {
    this.conversations.push(conversation);
  }
  public async find(id: string): Promise<Conversation | null> {
    return this.conversations.find((item) => item.id === id) ?? null;
  }
  public async listForRequester(key: string): Promise<Conversation[]> {
    return this.conversations.filter((item) => item.requesterIdentityKey === key);
  }
  public async appendTurn(input: AppendTurnInput, now: string): Promise<ConversationTurn> {
    const turn: ConversationTurn = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequence:
        this.turns.filter((item) => item.conversationId === input.conversationId).length + 1,
      kind: input.kind,
      actorIdentityKey: input.actorIdentityKey,
      content: input.content,
      citations: input.citations,
      modelId: input.modelId,
      correlationId: input.correlationId,
      createdAt: now
    };
    this.turns.push(turn);
    return turn;
  }
  public async findTurnByIdempotencyKey(id: string, key: string): Promise<ConversationTurn | null> {
    return this.turns.find((turn) => turn.conversationId === id && turn.content === key) ?? null;
  }
  public async listTurns(id: string): Promise<ConversationTurn[]> {
    return this.turns.filter((turn) => turn.conversationId === id);
  }
  public async updateClassification(): Promise<void> {}
}

const audit: AuditRepository = {
  async record(input) {
    return { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  },
  async list() {
    return [];
  }
};
const context = {
  actor: actorOf('salesperson'),
  correlationId: 'correlation',
  now: new Date('2026-10-15T00:00:00.000Z')
};

describe('ConversationService', () => {
  it('creates and lists only requester-owned conversations', async () => {
    const repository = new MemoryConversations();
    const service = new ConversationService(repository, audit);
    const conversation = await service.createConversation(context);
    expect((await service.listConversations(context)).map((item) => item.id)).toEqual([
      conversation.id
    ]);
    await expect(
      service.requireOwned({ ...context, actor: actorOf('pm') }, conversation.id)
    ).rejects.toThrow('Conversation not found');
  });

  it('records a question once for a repeated idempotency key', async () => {
    const repository = new MemoryConversations();
    const service = new ConversationService(repository, audit);
    const conversation = await service.createConversation(context);
    // The memory port uses content for its key lookup only in this test; seed the replay explicitly.
    const first = await service.recordQuestion(context, conversation, 'question', 'question');
    const replay = await service.recordQuestion(context, conversation, 'question', 'question');
    expect(first.created).toBe(true);
    expect(replay).toEqual({ turn: first.turn, created: false });
    expect(await service.listTurns(context, conversation.id)).toEqual([first.turn]);
  });
});
