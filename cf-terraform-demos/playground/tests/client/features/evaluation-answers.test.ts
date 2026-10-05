/**
 * @file Tests for the typed-answer presentation helpers. The important ones here guard wording
 *   rather than arithmetic: this panel renders two numbers that look alike and mean different
 *   things, and the wording is most of what keeps them apart.
 */

import { describe, expect, it } from 'vitest';
import {
  describeConfidence,
  describeEvaluationUsage,
  describeNoulStrength,
  describeScorePosition,
  formatProbability,
  probabilityBarWidthPercent,
  scorePositionPercent
} from '../../../src/client/components/results/evaluation-answers';

describe('probability presentation', () => {
  it('formats a probability as a percentage, which it genuinely is', () => {
    expect(formatProbability(0.9346)).toBe('93.5%');
    expect(formatProbability(0)).toBe('0.0%');
    expect(formatProbability(1)).toBe('100.0%');
  });

  it('clamps a bar so a value outside the range cannot overflow its track', () => {
    expect(probabilityBarWidthPercent(0.5)).toBe(50);
    expect(probabilityBarWidthPercent(1.4)).toBe(100);
    expect(probabilityBarWidthPercent(-0.3)).toBe(0);
  });
});

describe('describing a truth-valued judgement', () => {
  // The single most likely misreading of this panel is that a probability is a verdict, so the
  // middle band must not read as either answer.
  it('calls a mid-range probability uncertain rather than leaning either way', () => {
    expect(describeNoulStrength(0.52)).toBe('Genuinely uncertain');
    expect(describeNoulStrength(0.48)).toBe('Genuinely uncertain');
  });

  it('distinguishes strong from leaning at both ends', () => {
    expect(describeNoulStrength(0.96)).toBe('Strongly yes');
    expect(describeNoulStrength(0.72)).toBe('Leaning yes');
    expect(describeNoulStrength(0.2)).toBe('Leaning no');
    expect(describeNoulStrength(0.03)).toBe('Strongly no');
  });
});

describe('describing confidence', () => {
  // Confidence is a different axis from the answer: a low confidence does not mean "no".
  it('never describes a low confidence as a negative answer', () => {
    const phrase = describeConfidence(0.1782);
    expect(phrase).toContain('guess');
    expect(phrase).not.toMatch(/\bno\b/iu);
  });

  it('separates the confidence bands', () => {
    expect(describeConfidence(0.9334)).toBe('Very confident');
    expect(describeConfidence(0.6257)).toBe('Moderately confident');
    expect(describeConfidence(0.3462)).toBe('Low confidence');
  });

  // The live contrast the panel exists to show: the same answer, two very different confidences.
  it('describes a decisive-looking answer with low confidence as a guess', () => {
    expect(describeNoulStrength(0.7111)).toBe('Leaning yes');
    expect(describeConfidence(0.1782)).toContain('Very low confidence');
  });
});

describe('positioning a score on its legend', () => {
  it('divides by the number of intervals, not the number of entries', () => {
    // 3.51 on a five-entry legend is 3.51/4 of the way along.
    expect(scorePositionPercent(3.51, 5)).toBeCloseTo(87.75, 2);
    expect(scorePositionPercent(0, 5)).toBe(0);
    expect(scorePositionPercent(4, 5)).toBe(100);
  });

  it('handles a degenerate legend without dividing by zero', () => {
    expect(scorePositionPercent(0, 1)).toBe(50);
  });

  // The text alternative that lets the gauge be decoration.
  it('names the two legend entries a fractional score falls between', () => {
    const sentence = describeScorePosition(3.51, [
      'Calm and polite',
      'Mildly annoyed',
      'Clearly irritated',
      'Angry',
      'Furious and threatening to leave'
    ]);
    expect(sentence).toContain('between Angry and Furious and threatening to leave');
    expect(sentence).toContain('3.51');
  });

  it('names a single entry when the score lands exactly on one', () => {
    expect(describeScorePosition(1, ['Low', 'Middle', 'High'])).toContain('\u2014 Middle.');
  });
});

describe('describing what an evaluation cost', () => {
  // The asymmetric price shape made legible rather than left as a gap in a table.
  it('states the zero output charge and explains why there is one', () => {
    const sentence = describeEvaluationUsage(387, 0, 3);
    expect(sentence).toContain('no output tokens');
    expect(sentence).toContain('single model call');
    expect(sentence).toContain('rather than generated text');
  });

  it('reports a real output charge if a future model ever has one', () => {
    const sentence = describeEvaluationUsage(100, 42, 1);
    expect(sentence).toContain('42 output tokens');
    expect(sentence).not.toContain('no output tokens');
  });
});
