import { describe, expect, it } from 'vitest';
import {
  assignRanks,
  rankByCosineSimilarity,
  readEmbeddings,
  readRerankerScores,
  summariseVector
} from '../../../src/worker/domain/embedding-normalisation';
import { cosineSimilarity, vectorNorm } from '../../../src/worker/domain/vectors';

describe('embedding response normalisation', () => {
  it('accepts the only common field across the three verified live envelopes', () => {
    expect(
      readEmbeddings(
        {
          data: [
            [1, 0],
            [0, 1]
          ],
          shape: [2, 2],
          meta: {}
        },
        2
      )
    ).toEqual({
      ok: true,
      vectors: [
        [1, 0],
        [0, 1]
      ]
    });
    expect(readEmbeddings({ data: [[1, 0]], usage: {} }, 1)).toEqual({
      ok: true,
      vectors: [[1, 0]]
    });
    expect(readEmbeddings({ data: [[1, 0]], shape: [1, 2] }, 1)).toEqual({
      ok: true,
      vectors: [[1, 0]]
    });
  });

  it('refuses a wrong count because vectors are positional', () => {
    expect(readEmbeddings({ data: [[1, 0]] }, 2)).toEqual({
      ok: false,
      reason: 'wrong_cardinality'
    });
  });

  it('refuses non-finite values and inconsistent dimensions', () => {
    expect(readEmbeddings({ data: [[1, Number.NaN]] }, 1)).toEqual({
      ok: false,
      reason: 'malformed_vector'
    });
    expect(
      readEmbeddings(
        {
          data: [
            [1, 0],
            [1, 0, 0]
          ]
        },
        2
      )
    ).toEqual({ ok: false, reason: 'inconsistent_dimensions' });
  });
});

describe('cross-encoder response normalisation', () => {
  it('reads the verified id/score envelope and retains returned ordering only as data', () => {
    expect(
      readRerankerScores(
        {
          response: [
            { id: 1, score: 0.9845 },
            { id: 0, score: 0.00004 }
          ]
        },
        2
      )
    ).toEqual({
      ok: true,
      scores: [
        { index: 1, score: 0.9845 },
        { index: 0, score: 0.00004 }
      ]
    });
  });

  it('refuses an index outside the submitted collection', () => {
    expect(readRerankerScores({ response: [{ id: 3, score: 0.8 }] }, 2)).toEqual({
      ok: false,
      reason: 'index_out_of_range'
    });
  });
});

describe('local vector comparison', () => {
  it('computes cosine similarity and gives a zero vector a stable zero score', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(vectorNorm([3, 4])).toBe(5);
  });

  it('throws on different dimensions rather than comparing unrelated spaces', () => {
    expect(() => cosineSimilarity([1], [1, 0])).toThrow(/different dimensions/u);
  });

  it('ranks ties deterministically by collection position', () => {
    expect(
      assignRanks([
        { index: 2, score: 0.5, cached: false },
        { index: 0, score: 0.5, cached: true },
        { index: 1, score: 0.7, cached: false }
      ])
    ).toEqual([
      { rank: 1, index: 1, score: 0.7, cached: false },
      { rank: 2, index: 0, score: 0.5, cached: true },
      { rank: 3, index: 2, score: 0.5, cached: false }
    ]);
  });

  it('marks cache state alongside cosine rankings', () => {
    expect(
      rankByCosineSimilarity(
        [1, 0],
        [
          [0.9, 0.1],
          [0, 1]
        ],
        [true, false]
      )[0]
    ).toMatchObject({ index: 0, cached: true });
  });

  it('limits a vector disclosure while retaining dimension and magnitude', () => {
    expect(summariseVector([3, 4, 0])).toEqual({ dimensions: 3, preview: [3, 4, 0], norm: 5 });
  });
});
