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

// Looked up by identifier rather than by position. The follow-on added four embedding models
// between the originals and the reranker, and positional destructuring silently rebound every
// name — the suite still passed while asserting the wrong model's dimensions.
const byId = (id: string) => modelsForTask('semantic-search').find((model) => model.id === id);

const BGE_M3 = byId('@cf/baai/bge-m3');
const EMBEDDING_GEMMA = byId('@cf/google/embeddinggemma-300m');
const BGE_SMALL = byId('@cf/baai/bge-small-en-v1.5');
const PLAMO = byId('@cf/pfnet/plamo-embedding-1b');
const BGE_BASE = byId('@cf/baai/bge-base-en-v1.5');
const BGE_LARGE = byId('@cf/baai/bge-large-en-v1.5');
const QWEN3 = byId('@cf/qwen/qwen3-embedding-0.6b');
const RERANKER = byId('@cf/baai/bge-reranker-base');
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
  it('registers eight Cloudflare-hosted models with exactly one cross-encoder', () => {
    const models = modelsForTask('semantic-search');
    expect(models).toHaveLength(8);
    for (const model of models) expect(model.provider).toBe('workers-ai');

    const strategies = models.map((model) => model.semanticSearchControls?.strategy);
    expect(strategies.filter((strategy) => strategy === 'embedding')).toHaveLength(7);
    expect(strategies.filter((strategy) => strategy === 'cross-encoder')).toHaveLength(1);
  });

  it('publishes the verified embedding dimensions and cache boundary', () => {
    expect(BGE_M3?.semanticSearchControls?.dimensions).toBe(1_024);
    expect(EMBEDDING_GEMMA?.semanticSearchControls?.dimensions).toBe(768);
    expect(BGE_SMALL?.semanticSearchControls?.dimensions).toBe(384);
    expect(PLAMO?.semanticSearchControls?.dimensions).toBe(2_048);
    expect(BGE_BASE?.semanticSearchControls?.dimensions).toBe(768);
    expect(BGE_LARGE?.semanticSearchControls?.dimensions).toBe(1_024);
    expect(QWEN3?.semanticSearchControls?.dimensions).toBe(1_024);
    expect(BGE_M3?.semanticSearchControls?.cacheable).toBe(true);
    expect(RERANKER?.semanticSearchControls?.cacheable).toBe(false);
  });

  // The panel's central lesson is that a cosine score is a position within one vector space rather
  // than a portable measurement, and it is only demonstrable if the selector actually offers
  // several widths. Pinned as a count so a future curation pass cannot quietly collapse the range
  // back to one or two spaces while every other test still passes.
  it('spans four distinct vector spaces so scores cannot look comparable', () => {
    const widths = modelsForTask('semantic-search')
      .map((model) => model.semanticSearchControls?.dimensions)
      .filter((dimensions): dimensions is number => dimensions !== undefined);

    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([384, 768, 1_024, 2_048]);
  });

  // Every other embedding descriptor publishes a context window taken from a documented source.
  // PLaMo's is absent because neither its catalogue entry nor its documentation page states one,
  // and a reviewed registry must not invent a limit nobody reviewed. Pinned so the gap reads as a
  // recorded finding rather than an oversight somebody should "fix" with a plausible number.
  it('leaves PLaMo without a context window because none is published', () => {
    expect(PLAMO?.semanticSearchControls?.contextWindowTokens).toBeUndefined();
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
