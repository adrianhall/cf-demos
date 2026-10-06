import { beforeEach, describe, expect, it } from 'vitest';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { SemanticSearchService } from '../../../src/worker/application/semantic-search/semantic-search-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { validateSemanticSearchRequest } from '../../../src/worker/domain/semantic-search';
import {
  clearEmbeddingCache,
  createMemoryEmbeddingCache
} from '../../../src/worker/infrastructure/embeddings/memory-embedding-cache';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

// By identifier, not by position: the follow-on inserted four embedding models ahead of the
// reranker, and a positional binding would have pointed `RERANKER` at an embedding model while
// still type-checking.
const models = modelsForTask('semantic-search');
const BGE_M3 = models.find((model) => model.id === '@cf/baai/bge-m3');
const RERANKER = models.find((model) => model.id === '@cf/baai/bge-reranker-base');
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

function build(options: FakeInferenceOptions = {}): {
  service: SemanticSearchService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
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
  const runs = createMemoryRunRepository(now);
  return {
    service: new SemanticSearchService({
      inference,
      runs,
      embeddings: createMemoryEmbeddingCache(),
      logger,
      now
    }),
    inference,
    runs,
    logs: capture
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return validateSemanticSearchRequest({
    query: 'How do I reset my password?',
    model: BGE_M3!.id,
    runId: RUN_ID,
    passages: ['Visit Account Settings to reset your credentials.', 'The cafeteria serves lunch.'],
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
  clearEmbeddingCache();
});

describe('SemanticSearchService embeddings', () => {
  it('makes one query call and one batched passage call, then records both logs', async () => {
    const { service, inference, runs } = build();
    const response = await service.search(request(), ACTOR);
    expect(inference.requests).toHaveLength(2);
    expect(inference.requests[0]?.input).toEqual({ text: ['How do I reset my password?'] });
    expect(inference.requests[1]?.input).toEqual({
      text: ['Visit Account Settings to reset your credentials.', 'The cafeteria serves lunch.']
    });
    expect(response.receipt.logIds).toEqual(['log-1', 'log-1']);
    expect(response.result.usage).toMatchObject({
      inferenceCallCount: 2,
      embeddedPassageCount: 2,
      cachedPassageCount: 0,
      queryEmbedded: true
    });
    expect((await runs.find(RUN_ID))?.logIds).toHaveLength(2);
  });

  it('reuses query and passages on a repeat run, making no calls and reporting genuinely free work', async () => {
    const { service, inference } = build();
    await service.search(request(), ACTOR);
    const second = await service.search(
      request({ runId: 'b1b2c3d4-1111-4222-8333-444455556666' }),
      ACTOR
    );
    expect(inference.requests).toHaveLength(2);
    expect(second.receipt.costStatus).toBe('not-applicable');
    expect(second.receipt.logIds).toEqual([]);
    expect(second.result.usage).toEqual({
      inferenceCallCount: 0,
      embeddedPassageCount: 0,
      cachedPassageCount: 2,
      queryEmbedded: false
    });
    expect(second.result.rankings.every((entry) => entry.cached)).toBe(true);
  });

  it('embeds only an edited passage on a later search', async () => {
    let call = 0;
    const { service, inference } = build({
      output: () => {
        call += 1;
        return call === 1
          ? { data: [[1, 0]] }
          : call === 2
            ? {
                data: [
                  [0.5, 0.5],
                  [0, 1]
                ]
              }
            : { data: [[0.5, 0.5]] };
      }
    });
    await service.search(request({ passages: ['one', 'two'] }), ACTOR);
    const next = await service.search(
      request({ runId: 'b1b2c3d4-1111-4222-8333-444455556666', passages: ['one', 'three'] }),
      ACTOR
    );
    expect(inference.requests).toHaveLength(3);
    expect(next.result.usage).toMatchObject({
      inferenceCallCount: 1,
      embeddedPassageCount: 1,
      cachedPassageCount: 1,
      queryEmbedded: false
    });
  });

  it('refuses a positional provider response with the wrong number of vectors and logs no content', async () => {
    const { service, logs } = build({ output: () => ({ data: [[1, 0]] }) });
    await expect(service.search(request(), ACTOR)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });
    expect(logs.text()).not.toContain('How do I reset');
    expect(logs.text()).not.toContain(ACTOR.email);
    expect(logs.entries.map((entry) => entry.message)).toContain('semantic_search_output_unusable');
  });
});

describe('SemanticSearchService cross-encoder', () => {
  it('uses the model-side top-k contract and never consults the embedding cache', async () => {
    const { service, inference } = build({
      output: () => ({
        response: [
          { id: 1, score: 0.9845 },
          { id: 0, score: 0.00004 }
        ]
      })
    });
    const response = await service.search(request({ model: RERANKER!.id, topK: 1 }), ACTOR);
    expect(inference.requests).toHaveLength(1);
    expect(inference.requests[0]?.input).toEqual({
      query: 'How do I reset my password?',
      contexts: [
        { text: 'Visit Account Settings to reset your credentials.' },
        { text: 'The cafeteria serves lunch.' }
      ],
      top_k: 1
    });
    expect(response.result.strategy).toBe('cross-encoder');
    expect(response.result.queryVector).toBeUndefined();
    expect(response.result.rankings).toEqual([{ rank: 1, index: 1, score: 0.9845, cached: false }]);
    expect(response.applied.appliedBy).toBe('model');
  });
});
