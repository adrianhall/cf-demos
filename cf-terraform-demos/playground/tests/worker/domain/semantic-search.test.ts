import { describe, expect, it } from 'vitest';
import { MAX_SEMANTIC_SEARCH_PASSAGES } from '../../../src/shared/semantic-search';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  buildEmbeddingInput,
  buildRerankerInput,
  describeAppliedSemanticSearchControls,
  effectiveTopK,
  validateSemanticSearchRequest
} from '../../../src/worker/domain/semantic-search';
import { problemWithStatus, thrownBy } from '../support/problem-details';

const [BGE_M3, EMBEDDING_GEMMA, BGE_SMALL, RERANKER] = modelsForTask('semantic-search');
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: 'How do I reset my password?',
    passages: ['Visit Account Settings to reset your credentials.', 'The cafe serves lunch.'],
    model: BGE_M3!.id,
    runId: RUN_ID,
    ...overrides
  };
}

describe('the reviewed Semantic Search models', () => {
  it('registers four Cloudflare-hosted models with two distinct strategies', () => {
    const models = modelsForTask('semantic-search');
    expect(models).toHaveLength(4);
    for (const model of models) expect(model.provider).toBe('workers-ai');
    expect(models.map((model) => model.semanticSearchControls?.strategy)).toEqual([
      'embedding',
      'embedding',
      'embedding',
      'cross-encoder'
    ]);
  });

  it('publishes the verified embedding dimensions and cache boundary', () => {
    expect(BGE_M3?.semanticSearchControls?.dimensions).toBe(1_024);
    expect(EMBEDDING_GEMMA?.semanticSearchControls?.dimensions).toBe(768);
    expect(BGE_SMALL?.semanticSearchControls?.dimensions).toBe(384);
    expect(BGE_M3?.semanticSearchControls?.cacheable).toBe(true);
    expect(RERANKER?.semanticSearchControls?.cacheable).toBe(false);
  });

  it('declares the reranker top-k as model-side and its floor collapse', () => {
    expect(RERANKER?.semanticSearchControls?.appliedBy).toBe('model');
    expect(RERANKER?.semanticSearchControls?.collapsesIrrelevantScores).toBe(true);
  });
});

describe('Semantic Search request validation', () => {
  it('resolves a reviewed model and applies its default result count', () => {
    const request = validateSemanticSearchRequest(body());
    expect(request.model).toBe(BGE_M3);
    expect(effectiveTopK(request)).toBe(5);
  });

  it.each(['user', 'email', 'actor', 'sub'])('refuses an identity field: %s', (field) => {
    expect(
      thrownBy(() => validateSemanticSearchRequest(body({ [field]: 'forged@example.com' })))
    ).toMatchObject(problemWithStatus(400));
  });

  it.each(['metric', 'similarity', 'weights', 'boost', 'keywords', 'rerank'])(
    'refuses a caller-defined scoring rule: %s',
    (field) => {
      expect(
        thrownBy(() => validateSemanticSearchRequest(body({ [field]: 'caller value' })))
      ).toMatchObject(problemWithStatus(400));
    }
  );

  it('refuses blank queries and passages because positional results cannot skip a row', () => {
    expect(thrownBy(() => validateSemanticSearchRequest(body({ query: '  ' })))).toMatchObject(
      problemWithStatus(400)
    );
    expect(
      thrownBy(() => validateSemanticSearchRequest(body({ passages: ['good', '  '] })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses an over-large collection as a cost bound', () => {
    expect(
      thrownBy(() =>
        validateSemanticSearchRequest(
          body({ passages: Array(MAX_SEMANTIC_SEARCH_PASSAGES + 1).fill('a') })
        )
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('builds a batched embedding request', () => {
    expect(buildEmbeddingInput(['query', 'passage'])).toEqual({ text: ['query', 'passage'] });
  });

  it('builds the documented reranker input including its otherwise-missing generated query field', () => {
    expect(buildRerankerInput('reset password', ['change credentials'], 1)).toEqual({
      query: 'reset password',
      contexts: [{ text: 'change credentials' }],
      top_k: 1
    });
  });

  it('reports the selected model strategy without echoing the query or passages', () => {
    const applied = describeAppliedSemanticSearchControls(
      validateSemanticSearchRequest(body({ topK: 2 }))
    );
    expect(applied).toEqual({
      model: BGE_M3!.id,
      strategy: 'embedding',
      topK: 2,
      appliedBy: 'playground',
      passageCount: 2,
      queryCharacterCount: 27
    });
  });
});
