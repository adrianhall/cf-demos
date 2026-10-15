import { describe, expect, it } from 'vitest';
import { EscalationService } from '../../../src/worker/application/escalation-service';
import type { AuditRepository } from '../../../src/worker/domain/audit';
import type {
  ConversationRepository,
  ConversationTurn
} from '../../../src/worker/domain/conversation';
import type {
  Escalation,
  EscalationAssignment,
  EscalationRepository
} from '../../../src/worker/domain/escalation';
import { actorOf } from '../support/actors';
import { MemoryFaqRepository, MemoryIndexJobRepository } from '../support/fake-repositories';

class MemoryEscalations implements EscalationRepository {
  public readonly items: Escalation[] = [];
  public readonly history: EscalationAssignment[] = [];
  public async open(item: Escalation): Promise<Escalation> {
    const existing = await this.findByQuestion(item.questionEventId);
    if (existing !== null) return existing;
    this.items.push(item);
    return item;
  }
  public async find(id: string): Promise<Escalation | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }
  public async findByQuestion(questionEventId: string): Promise<Escalation | null> {
    return this.items.find((item) => item.questionEventId === questionEventId) ?? null;
  }
  public async list(products: string[] | null): Promise<Escalation[]> {
    return this.items.filter(
      (item) => products === null || (item.productId !== null && products.includes(item.productId))
    );
  }
  public async assignments(id: string): Promise<EscalationAssignment[]> {
    return this.history.filter((item) => item.escalationId === id);
  }
  public async assign(item: Escalation, assignment: EscalationAssignment): Promise<void> {
    const index = this.items.findIndex((stored) => stored.id === item.id);
    this.items[index] = item;
    this.history.push(assignment);
  }
  public async update(item: Escalation): Promise<void> {
    const index = this.items.findIndex((stored) => stored.id === item.id);
    this.items[index] = item;
  }
}
class MemoryConversations implements ConversationRepository {
  public readonly turns: ConversationTurn[] = [
    {
      id: 'question',
      conversationId: 'conversation',
      sequence: 1,
      kind: 'question',
      actorIdentityKey: 'sales',
      content: 'What is D1?',
      citations: [],
      modelId: null,
      correlationId: 'c',
      createdAt: '2026-10-15T00:00:00.000Z'
    }
  ];
  public status = 'escalated';
  public async create(): Promise<void> {}
  public async find(): Promise<null> {
    return null;
  }
  public async listForRequester() {
    return [];
  }
  public async appendTurn(
    input: Parameters<ConversationRepository['appendTurn']>[0],
    now: string
  ): Promise<ConversationTurn> {
    const turn = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      sequence: this.turns.length + 1,
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
  public async findTurnByIdempotencyKey(): Promise<null> {
    return null;
  }
  public async listTurns(): Promise<ConversationTurn[]> {
    return this.turns;
  }
  public async updateClassification(
    _id: string,
    _product: string | null,
    status: 'open' | 'escalated' | 'closed'
  ): Promise<void> {
    this.status = status;
  }
}
const audit: AuditRepository = {
  async record(input) {
    return { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  },
  async list() {
    return [];
  }
};
const now = new Date('2026-10-15T00:00:00.000Z');
function setup(): {
  service: EscalationService;
  queue: MemoryEscalations;
  conversations: MemoryConversations;
} {
  const queue = new MemoryEscalations();
  queue.items.push({
    id: 'escalation',
    conversationId: 'conversation',
    questionEventId: 'question',
    productId: 'd1',
    currentAssignee: 'Rita Koslov',
    reason: 'requested',
    status: 'open',
    openedAt: now.toISOString()
  });
  return {
    service: new EscalationService(
      queue,
      new MemoryConversations(),
      new MemoryFaqRepository(),
      new MemoryIndexJobRepository(),
      audit
    ),
    queue,
    conversations: new MemoryConversations()
  };
}
const pmContext = { actor: actorOf('pm', { productScopes: ['d1'] }), correlationId: 'c', now };

describe('EscalationService', () => {
  it('rejects duplicate opening and blocks direct and longer reassignment cycles', async () => {
    const { service, queue } = setup();
    expect(await queue.open(queue.items[0]!)).toBe(queue.items[0]);
    await service.reassign(pmContext, 'escalation', 'Taylor Smith');
    await service.reassign(pmContext, 'escalation', 'Michelle Chen');
    await expect(service.reassign(pmContext, 'escalation', 'Rita Koslov')).rejects.toThrow('cycle');
    await expect(service.reassign(pmContext, 'escalation', 'Taylor Smith')).rejects.toThrow(
      'cycle'
    );
  });
  it('enforces PM scope and lets administrators see all queue items', async () => {
    const { service } = setup();
    await expect(service.list({ ...pmContext, actor: actorOf('salesperson') })).rejects.toThrow(
      'not found'
    );
    await expect(
      service.reassign(
        { ...pmContext, actor: actorOf('pm', { productScopes: [] }) },
        'escalation',
        'Taylor Smith'
      )
    ).rejects.toThrow('scope');
    expect(await service.list({ ...pmContext, actor: actorOf('administrator') })).toHaveLength(1);
  });
  it('delivers an answer to the original transcript and publishes retryable FAQ work', async () => {
    const queue = new MemoryEscalations();
    queue.items.push({
      id: 'escalation',
      conversationId: 'conversation',
      questionEventId: 'question',
      productId: 'd1',
      currentAssignee: 'Rita Koslov',
      reason: 'requested',
      status: 'assigned',
      openedAt: now.toISOString()
    });
    const conversations = new MemoryConversations();
    const faqs = new MemoryFaqRepository();
    const jobs = new MemoryIndexJobRepository();
    const service = new EscalationService(queue, conversations, faqs, jobs, audit);
    const turn = await service.answer(pmContext, 'escalation', {
      answer: 'Use D1.',
      publishFaq: true,
      audience: 'internal'
    });
    expect(turn.content).toBe('Use D1.');
    expect(queue.items[0]?.status).toBe('delivered');
    expect(conversations.status).toBe('open');
    expect(faqs.revisions).toHaveLength(1);
    expect(jobs.jobs).toHaveLength(1);
  });
  it('rejects an open escalation into the original conversation', async () => {
    const { service } = setup();
    const turn = await service.reject(pmContext, 'escalation', 'This request is out of scope.');
    expect(turn.kind).toBe('rejection');
  });
});
