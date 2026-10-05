/**
 * @file Domain tests for Evaluate Choices. Several of these pin rules that are **the provider's
 *   own**, reimplemented locally so a refusal can name the question a visitor is editing rather
 *   than a field in a payload they never saw. Each such test says which live error it stands in
 *   for, so a future reader can tell a reimplemented provider rule from an invented one.
 */

import { describe, expect, it } from 'vitest';
import {
  EVALUATION_QUESTION_TYPES,
  MAX_EVALUATION_QUESTIONS,
  type EvaluationQuestion
} from '../../../src/shared/evaluate-choices';
import {
  buildEvaluationInput,
  countQuestionTypes,
  describeAppliedEvaluationControls,
  validateEvaluateChoicesRequest
} from '../../../src/worker/domain/evaluate-choices';
import { modelsForTask } from '../../../src/worker/domain/models';
import { problemWithStatus, thrownBy } from '../support/problem-details';

const [CLEF, CLEF_FLASH] = modelsForTask('evaluate-choices');
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

const NOUL: EvaluationQuestion = {
  name: 'urgent',
  question: {
    type: 'noul',
    instructions: 'Is this ticket urgent?',
    whenTrue: 'Blocks the customer or names a deadline.',
    whenFalse: 'Can wait several days.'
  }
};

const CHOICE: EvaluationQuestion = {
  name: 'department',
  question: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    options: [
      { name: 'BILLING', description: 'Payments and refunds.' },
      { name: 'ENGINEERING', description: 'Bugs and outages.' }
    ]
  }
};

const SCORE: EvaluationQuestion = {
  name: 'frustration',
  question: {
    type: 'score',
    instructions: 'How frustrated is the customer?',
    legend: ['Calm', 'Irritated', 'Furious']
  }
};

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'The checkout page returns a 500 error.',
    stateFormat: 'text',
    questions: [NOUL],
    model: CLEF?.id,
    runId: RUN_ID,
    ...overrides
  };
}

describe('the reviewed Evaluate Choices models', () => {
  it('registers both Cloudflare-hosted decision models', () => {
    const models = modelsForTask('evaluate-choices');
    expect(models.map((model) => model.id)).toEqual([
      '@cf/cloudflare/clef',
      '@cf/cloudflare/clef-flash'
    ]);
    for (const model of models) {
      expect(model.provider).toBe('workers-ai');
      expect(model.evaluationControls?.supportedQuestionTypes).toEqual(['noul', 'choice', 'score']);
      expect(model.evaluationControls?.contextWindowTokens).toBe(65_536);
    }
  });

  // The body's `model` field must agree with the endpoint. Verified live: sending "clef" to the
  // clef-flash endpoint fails with `Unsupported model 'clef'. Use 'clef-flash'.`
  it('records the exact request model name each endpoint demands', () => {
    expect(CLEF?.evaluationControls?.requestModelName).toBe('clef');
    expect(CLEF_FLASH?.evaluationControls?.requestModelName).toBe('clef-flash');
  });

  it('publishes the asymmetric price so the panel can explain it', () => {
    expect(CLEF?.evaluationControls?.inputPricePerMillionTokens).toBe(0.24);
    expect(CLEF_FLASH?.evaluationControls?.inputPricePerMillionTokens).toBe(0.09);
  });
});

describe('Evaluate Choices request validation', () => {
  it('accepts a caller-defined question, unlike Classify Text next door', () => {
    const request = validateEvaluateChoicesRequest(body({ questions: [NOUL, CHOICE, SCORE] }));
    expect(request.model).toBe(CLEF);
    expect(request.questions).toHaveLength(3);
  });

  it.each(['user', 'email', 'actor', 'sub'])('refuses an identity field: %s', (field) => {
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ [field]: 'forged@example.com' })))
    ).toMatchObject(problemWithStatus(400));
  });

  // The boundary that keeps this a typed contract rather than a chat endpoint. There is nothing
  // for a temperature to act on: the model returns calibrated probabilities, not sampled tokens.
  it.each([
    'prompt',
    'system',
    'messages',
    'temperature',
    'max_tokens',
    'response_format',
    'stream'
  ])('refuses the generative control %s', (field) => {
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ [field]: 'anything' })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('names the Chat panel when a prompt is supplied, so the refusal is actionable', () => {
    const error = thrownBy(() => validateEvaluateChoicesRequest(body({ prompt: 'judge this' })));
    expect((error as { problemDetails: { detail: string } }).problemDetails.detail).toContain(
      'Chat panel'
    );
  });

  it('refuses a JSON state that does not parse, rather than sending it as text', () => {
    expect(
      thrownBy(() =>
        validateEvaluateChoicesRequest(body({ stateFormat: 'json', state: '{ not json' }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses a JSON state with no fields for a question to refer to', () => {
    expect(
      thrownBy(() =>
        validateEvaluateChoicesRequest(body({ stateFormat: 'json', state: '"just a string"' }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('parses a structured state so the model receives fields rather than braces', () => {
    const request = validateEvaluateChoicesRequest(
      body({ stateFormat: 'json', state: '{"order":{"days_since":40}}' })
    );
    expect(request.parsedState).toEqual({ order: { days_since: 40 } });
  });

  // The provider's own pattern. Verified live: a name containing a space is rejected with
  // `String should match pattern '^[A-Za-z0-9_.-]{1,100}$'`.
  it('refuses a question name the provider would reject', () => {
    expect(
      thrownBy(() =>
        validateEvaluateChoicesRequest(body({ questions: [{ ...NOUL, name: 'my question' }] }))
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses two questions sharing a name, which would silently lose one answer', () => {
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ questions: [NOUL, { ...NOUL }] })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses two options sharing a name, which would collapse into one probability', () => {
    const duplicated: EvaluationQuestion = {
      name: 'dept',
      question: {
        type: 'choice',
        instructions: 'Which team?',
        options: [
          { name: 'SAME', description: 'First.' },
          { name: 'SAME', description: 'Second.' }
        ]
      }
    };
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ questions: [duplicated] })))
    ).toMatchObject(problemWithStatus(400));
  });

  // The provider's own floor. Verified live: a one-option choice is rejected with
  // `Dictionary should have at least 2 items after validation, not 1`.
  it('refuses a single-option choice, as the model does', () => {
    const lonely: EvaluationQuestion = {
      name: 'only',
      question: {
        type: 'choice',
        instructions: 'Which?',
        options: [{ name: 'ONLY', description: 'The only one.' }]
      }
    };
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ questions: [lonely] })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses a single-entry score legend, as the model does', () => {
    const lonely: EvaluationQuestion = {
      name: 'only',
      question: { type: 'score', instructions: 'Rate', legend: ['Only'] }
    };
    expect(
      thrownBy(() => validateEvaluateChoicesRequest(body({ questions: [lonely] })))
    ).toMatchObject(problemWithStatus(400));
  });

  it('refuses more questions than one call should carry', () => {
    const many = Array.from({ length: MAX_EVALUATION_QUESTIONS + 1 }, (_, index) => ({
      ...NOUL,
      name: `question_${index}`
    }));
    expect(thrownBy(() => validateEvaluateChoicesRequest(body({ questions: many })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('refuses an empty state and an empty question list', () => {
    expect(thrownBy(() => validateEvaluateChoicesRequest(body({ state: '  ' })))).toMatchObject(
      problemWithStatus(400)
    );
    expect(thrownBy(() => validateEvaluateChoicesRequest(body({ questions: [] })))).toMatchObject(
      problemWithStatus(400)
    );
  });

  it('refuses a question type no reviewed type matches', () => {
    expect(
      thrownBy(() =>
        validateEvaluateChoicesRequest(
          body({ questions: [{ name: 'a', question: { type: 'ranking', instructions: 'x' } }] })
        )
      )
    ).toMatchObject(problemWithStatus(400));
  });

  it('accepts a noul question with no criteria, because the model does', () => {
    const bare: EvaluationQuestion = {
      name: 'urgent',
      question: { type: 'noul', instructions: 'Is this urgent?' }
    };
    const request = validateEvaluateChoicesRequest(body({ questions: [bare] }));
    expect(request.questions[0]?.question).toEqual({
      type: 'noul',
      instructions: 'Is this urgent?'
    });
  });
});

describe('Evaluate Choices provider input', () => {
  it('sends the endpoint-matching model name, since a mismatch is refused by the provider', () => {
    const input = buildEvaluationInput(validateEvaluateChoicesRequest(body()));
    expect(input['model']).toBe('clef');

    const flash = buildEvaluationInput(
      validateEvaluateChoicesRequest(body({ model: CLEF_FLASH?.id }))
    );
    expect(flash['model']).toBe('clef-flash');
  });

  it('keys noul criteria as true and false', () => {
    const input = buildEvaluationInput(validateEvaluateChoicesRequest(body()));
    expect(input['questions']).toEqual({
      urgent: {
        type: 'noul',
        instructions: 'Is this ticket urgent?',
        criteria: {
          true: 'Blocks the customer or names a deadline.',
          false: 'Can wait several days.'
        }
      }
    });
  });

  it('omits noul criteria entirely when none were given', () => {
    const bare: EvaluationQuestion = {
      name: 'urgent',
      question: { type: 'noul', instructions: 'Is this urgent?' }
    };
    const input = buildEvaluationInput(validateEvaluateChoicesRequest(body({ questions: [bare] })));
    expect(input['questions']).toEqual({
      urgent: { type: 'noul', instructions: 'Is this urgent?' }
    });
  });

  it('sends choice criteria as an object keyed by option name', () => {
    const input = buildEvaluationInput(
      validateEvaluateChoicesRequest(body({ questions: [CHOICE] }))
    );
    expect(input['questions']).toEqual({
      department: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: { BILLING: 'Payments and refunds.', ENGINEERING: 'Bugs and outages.' }
      }
    });
  });

  // The asymmetry that would otherwise be a runtime failure. Verified live: sending a score
  // legend as an object fails with `Input should be a valid list`.
  it('sends score criteria as an ordered array, not an object', () => {
    const input = buildEvaluationInput(
      validateEvaluateChoicesRequest(body({ questions: [SCORE] }))
    );
    expect(input['questions']).toEqual({
      frustration: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Irritated', 'Furious']
      }
    });
  });

  it('sends the parsed document for a JSON state', () => {
    const input = buildEvaluationInput(
      validateEvaluateChoicesRequest(
        body({ stateFormat: 'json', state: '{"order":{"days_since":40}}' })
      )
    );
    expect(input['state']).toEqual({ order: { days_since: 40 } });
  });
});

describe('Evaluate Choices applied controls', () => {
  it('counts question types without echoing the state or the wording', () => {
    const applied = describeAppliedEvaluationControls(
      validateEvaluateChoicesRequest(body({ questions: [NOUL, CHOICE, SCORE] }))
    );
    expect(applied).toEqual({
      model: CLEF?.id,
      stateFormat: 'text',
      questionCount: 3,
      questionTypeCounts: { noul: 1, choice: 1, score: 1 },
      stateCharacterCount: 38
    });
    expect(JSON.stringify(applied)).not.toContain('checkout');
  });

  it('counts every reviewed question type, including the absent ones', () => {
    const counts = countQuestionTypes([NOUL]);
    expect(Object.keys(counts).sort()).toEqual([...EVALUATION_QUESTION_TYPES].sort());
    expect(counts).toEqual({ noul: 1, choice: 0, score: 0 });
  });
});
