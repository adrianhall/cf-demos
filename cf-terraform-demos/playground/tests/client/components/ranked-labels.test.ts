import { describe, expect, it } from 'vitest';
import {
  barWidthPercent,
  describeVisibleLabels,
  formatScore
} from '../../../src/client/components/results/ranked-labels';

describe('formatScore', () => {
  it('formats a score as a percentage', () => {
    expect(formatScore(0.932)).toBe('93.2%');
  });

  // One decimal place is enough to separate a close first and second place, which is the single
  // most informative comparison in a ranking.
  it('keeps one decimal place so a close pair stays distinguishable', () => {
    expect(formatScore(0.412)).not.toBe(formatScore(0.418));
  });

  it.each([
    [0, '0.0%'],
    [1, '100.0%']
  ])('formats the boundary score %s', (score, expected) => {
    expect(formatScore(score)).toBe(expected);
  });
});

describe('barWidthPercent', () => {
  it('converts a score to a percentage width', () => {
    expect(barWidthPercent(0.25)).toBe(25);
  });

  // The Worker already refuses an out-of-range score. This is the second of the two places that
  // would have to fail for a bar to be painted outside its own track.
  it.each([
    [-1, 0],
    [2, 100]
  ])('clamps %s to %s', (score, expected) => {
    expect(barWidthPercent(score)).toBe(expected);
  });
});

describe('describeVisibleLabels', () => {
  // Phrased as "of the labels this model returned" rather than "top N", because the model was not
  // asked for N — it scored everything it scores and the panel kept some.
  it('says how much of the model\u2019s answer is on screen', () => {
    expect(describeVisibleLabels(3, 5)).toBe('Showing 3 of the 5 labels this model returned.');
  });

  it('says so plainly when nothing was hidden', () => {
    expect(describeVisibleLabels(5, 5)).toBe('Showing all 5 labels this model returned.');
  });

  it('uses the singular for one label', () => {
    expect(describeVisibleLabels(1, 1)).toBe('Showing all 1 label this model returned.');
  });

  it('says nothing when the model returned nothing', () => {
    expect(describeVisibleLabels(0, 0)).toBe('');
  });
});
