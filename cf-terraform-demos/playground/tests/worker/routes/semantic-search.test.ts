import { describe, expect, it } from 'vitest';
import type { SemanticSearchResponse } from '../../../src/shared/semantic-search';
import { SemanticSearchService } from '../../../src/worker/application/semantic-search/semantic-search-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { createMemoryEmbeddingCache } from '../../../src/worker/infrastructure/embeddings/memory-embedding-cache';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { semanticSearchRouter } from '../../../src/worker/routes/semantic-search';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute } from '../support/mount';

// By identifier, not by position: the follow-on inserted four embedding models ahead of the
// reranker, and a positional binding would have pointed `RERANKER` at an embedding model while
// still type-checking.
const models = modelsForTask('semantic-search');
const BGE_M3 = models.find((model) => model.id === '@cf/baai/bge-m3');
const RERANKER = models.find((model) => model.id === '@cf/baai/bge-reranker-base');
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: 'How do I reset my password?',
    model: BGE_M3!.id,
    passages: ['Visit Account Settings to reset your credentials.', 'The cafeteria serves lunch.'],
    runId: 'a1b2c3d4-1111-4222-8333-444455556666',
    ...overrides
  };
}

function mount(options: FakeInferenceOptions = {}) {
  let call = 0;
  const inference = new FakeInference({
    output: () => {
      call += 1;
      return call === 1
        ? { data: [[1, 0]] }
        : {
            data: [
              [0.9, 0.1],
              [0, 1]
            ]
          };
    },
    ...options
  });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new SemanticSearchService({
    inference,
    runs: createMemoryRunRepository(now),
    embeddings: createMemoryEmbeddingCache(),
    logger,
    now
  });
  const mounted = mountRoute('/api/semantic-search', semanticSearchRouter, {
    identity: IDENTITY,
    semanticSearchService: service,
    logger
  });
  return { app: mounted.app, inference, logs: capture };
}

async function post(
  app: ReturnType<typeof mount>['app'],
  request: Record<string, unknown>
): Promise<Response> {
  return app.request('/api/semantic-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
}

describe('the Semantic Search route', () => {
  it('returns one receipt for the query plus a batched collection, without logging content', async () => {
    const { app, inference, logs } = mount();
    const response = await post(app, body());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as SemanticSearchResponse;
    expect(payload.receipt.task).toBe('semantic-search');
    expect(payload.receipt.logIds).toHaveLength(2);
    expect(payload.result.rankings[0]).toMatchObject({ index: 0, cached: false });
    expect(inference.requests).toHaveLength(2);
    expect(logs.entries.map((entry) => entry.message)).toEqual([
      'semantic_search_run_started',
      'semantic_search_run_completed'
    ]);
    expect(logs.text()).not.toContain('How do I reset');
    expect(logs.text()).not.toContain('Account Settings');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  it('sends the reviewed model-side result count to the cross-encoder', async () => {
    const { app, inference } = mount({ output: () => ({ response: [{ id: 1, score: 0.98 }] }) });
    const response = await post(app, body({ model: RERANKER!.id, topK: 1 }));
    expect(response.status).toBe(200);
    expect(inference.requests[0]?.input).toMatchObject({
      top_k: 1,
      query: 'How do I reset my password?'
    });
  });

  it('rejects a claimed scoring metric before reaching inference', async () => {
    const { app, inference } = mount();
    const response = await post(app, body({ metric: 'euclidean' }));
    expect(response.status).toBe(400);
    expect(inference.requests).toEqual([]);
  });
});
