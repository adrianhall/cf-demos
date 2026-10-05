/**
 * @file Normalisation tests for Evaluate Choices. The fixtures below are **real** responses
 *   captured from the live models with `cf ai run`, not shapes invented to match the reader. That
 *   matters most for the asymmetry these tests pin: a `noul` answer carries no confidence while a
 *   `choice` and a `score` do, which a hand-written fixture would have been very likely to "tidy
 *   up" into consistency.
 */

import { describe, expect, it } from 'vitest';
import type { EvaluationQuestion } from '../../../src/shared/evaluate-choices';
import { readEvaluationAnswers } from '../../../src/worker/domain/evaluation-normalisation';

const NOUL: EvaluationQuestion = {
  name: 'urgent',
  question: { type: 'noul', instructions: 'Is this ticket urgent?' }
};

const CHOICE: EvaluationQuestion = {
  name: 'department',
  question: {
    type: 'choice',
    instructions: 'Which team?',
    options: [
      { name: 'BILLING', description: 'Payments.' },
      { name: 'ENGINEERING', description: 'Bugs.' },
      { name: 'SALES', description: 'Pricing.' }
    ]
  }
};

const SCORE: EvaluationQuestion = {
  name: 'frustration',
  question: {
    type: 'score',
    instructions: 'How frustrated?',
    legend: ['Calm', 'Irritated', 'Furious']
  }
};

/**
 * A real multi-question response from `@cf/cloudflare/clef-flash`.
 */
const LIVE_RESPONSE = {
  model: 'clef-flash',
  answers: {
    urgent: { type: 'noul', noul: 0.9573 },
    department: {
      type: 'choice',
      choice: 'ENGINEERING',
      probabilities: { BILLING: 0.1088, ENGINEERING: 0.8588, SALES: 0.0324 },
      confidence: 0.6257
    },
    frustration: {
      type: 'score',
      score: 1.8,
      legend: { '0': 'Calm', '1': 'Irritated', '2': 'Furious' },
      probabilities: { '0': 0.0077, '1': 0.3548, '2': 0.5914 },
      confidence: 0.3462
    }
  },
  usage: { input_tokens: 387, output_tokens: 0 }
};

describe('reading the live evaluation envelope', () => {
  it('reads all three answer types from one real response', () => {
    const read = readEvaluationAnswers(LIVE_RESPONSE, [NOUL, CHOICE, SCORE]);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }

    expect(read.answers.map((entry) => entry.name)).toEqual([
      'urgent',
      'department',
      'frustration'
    ]);
    expect(read.unansweredQuestions).toEqual([]);
    expect(read.usage).toEqual({ inputTokens: 387, outputTokens: 0 });
  });

  // The contract asymmetry. A `noul` has no confidence on any live call, and the union models
  // that absence rather than defaulting it to zero.
  it('gives a noul answer a probability and no confidence at all', () => {
    const read = readEvaluationAnswers(LIVE_RESPONSE, [NOUL]);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }

    expect(read.answers[0]?.answer).toEqual({ type: 'noul', probability: 0.9573 });
    expect(read.answers[0]?.answer).not.toHaveProperty('confidence');
  });

  it('keeps choice probabilities in the caller\u2019s option order and marks the winner', () => {
    const read = readEvaluationAnswers(LIVE_RESPONSE, [CHOICE]);
    expect(read.ok).toBe(true);
    if (!read.ok || read.answers[0]?.answer.type !== 'choice') {
      return;
    }

    const answer = read.answers[0].answer;
    expect(answer.choice).toBe('ENGINEERING');
    expect(answer.confidence).toBe(0.6257);
    expect(answer.probabilities).toEqual([
      { name: 'BILLING', probability: 0.1088, selected: false },
      { name: 'ENGINEERING', probability: 0.8588, selected: true },
      { name: 'SALES', probability: 0.0324, selected: false }
    ]);
  });

  it('reads a score legend by position rather than by key order', () => {
    const read = readEvaluationAnswers(LIVE_RESPONSE, [SCORE]);
    expect(read.ok).toBe(true);
    if (!read.ok || read.answers[0]?.answer.type !== 'score') {
      return;
    }

    const answer = read.answers[0].answer;
    expect(answer.score).toBe(1.8);
    expect(answer.legend).toEqual(['Calm', 'Irritated', 'Furious']);
    // The mode is marked, not the rounded score: the score is continuous and may sit between two
    // legend entries while the distribution has a clear peak.
    expect(answer.probabilities.find((entry) => entry.selected)?.name).toBe('Furious');
  });

  it('returns answers in the order the questions were asked, not the response key order', () => {
    const read = readEvaluationAnswers(LIVE_RESPONSE, [SCORE, NOUL, CHOICE]);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.answers.map((entry) => entry.name)).toEqual([
      'frustration',
      'urgent',
      'department'
    ]);
  });
});

describe('refusing an answer that cannot be trusted', () => {
  it('refuses a response with no answers object at all', () => {
    expect(readEvaluationAnswers({ model: 'clef' }, [NOUL])).toEqual({
      ok: false,
      reason: 'unrecognised_shape'
    });
  });

  it('refuses when not one answer matched its question type', () => {
    expect(
      readEvaluationAnswers({ answers: { urgent: { type: 'choice', choice: 'X' } } }, [NOUL])
    ).toEqual({ ok: false, reason: 'no_usable_answers' });
  });

  // Rendering a `choice` with the `score` card would produce a gauge positioned against a legend
  // that was never computed, so a mismatched type is dropped rather than coerced.
  it('drops a single mistyped answer while keeping the rest', () => {
    const read = readEvaluationAnswers(
      {
        answers: {
          urgent: { type: 'noul', noul: 0.9 },
          department: { type: 'score', score: 1 }
        },
        usage: { input_tokens: 10, output_tokens: 0 }
      },
      [NOUL, CHOICE]
    );

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.answers).toHaveLength(1);
    expect(read.unansweredQuestions).toEqual(['department']);
  });

  it('drops a choice naming an option the caller never offered', () => {
    const read = readEvaluationAnswers(
      {
        answers: {
          urgent: { type: 'noul', noul: 0.5 },
          department: {
            type: 'choice',
            choice: 'CATERING',
            probabilities: { BILLING: 0.1, ENGINEERING: 0.8, SALES: 0.1 },
            confidence: 0.5
          }
        }
      },
      [NOUL, CHOICE]
    );

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.unansweredQuestions).toEqual(['department']);
  });

  it('drops a choice missing a probability for an offered option', () => {
    const read = readEvaluationAnswers(
      {
        answers: {
          urgent: { type: 'noul', noul: 0.5 },
          department: {
            type: 'choice',
            choice: 'ENGINEERING',
            probabilities: { BILLING: 0.2, ENGINEERING: 0.8 },
            confidence: 0.5
          }
        }
      },
      [NOUL, CHOICE]
    );

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.unansweredQuestions).toEqual(['department']);
  });

  it.each([
    ['above one', 1.4],
    ['negative', -0.2],
    ['not a number', 'high']
  ])('drops a noul whose probability is %s', (_label, value) => {
    const read = readEvaluationAnswers(
      {
        answers: {
          urgent: { type: 'noul', noul: value },
          department: {
            type: 'choice',
            choice: 'BILLING',
            probabilities: { BILLING: 1, ENGINEERING: 0, SALES: 0 },
            confidence: 0.9
          }
        }
      },
      [NOUL, CHOICE]
    );

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.unansweredQuestions).toEqual(['urgent']);
  });

  it('reports zero usage rather than failing when the provider omits it', () => {
    const read = readEvaluationAnswers({ answers: { urgent: { type: 'noul', noul: 0.4 } } }, [
      NOUL
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
