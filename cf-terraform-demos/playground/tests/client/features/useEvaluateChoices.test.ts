import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useEvaluateChoices } from '../../../src/client/features/evaluate-choices/useEvaluateChoices';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import {
  MAX_EVALUATION_QUESTIONS,
  MIN_EVALUATION_OPTIONS,
  type EvaluateChoicesResponse
} from '../../../src/shared/evaluate-choices';

const CLEF: CatalogueModel = {
  id: '@cf/cloudflare/clef',
  name: 'Clef (27B decision model)',
  provider: 'workers-ai',
  task: 'evaluate-choices',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/clef',
  evaluationControls: {
    requestModelName: 'clef',
    supportedQuestionTypes: ['noul', 'choice', 'score'],
    reportsConfidence: true,
    contextWindowTokens: 65_536,
    inputPricePerMillionTokens: 0.24
  }
};

const CLEF_FLASH: CatalogueModel = {
  ...CLEF,
  id: '@cf/cloudflare/clef-flash',
  name: 'Clef Flash (9B decision model)',
  evaluationControls: {
    ...CLEF.evaluationControls!,
    requestModelName: 'clef-flash',
    inputPricePerMillionTokens: 0.09
  }
};

const RESPONSE: EvaluateChoicesResponse = {
  result: {
    answers: [{ name: 'urgent', answer: { type: 'noul', probability: 0.96 } }],
    unansweredQuestions: [],
    usage: { inputTokens: 158, outputTokens: 0 }
  },
  receipt: {
    runId: 'run-1',
    task: 'evaluate-choices',
    model: CLEF.id,
    gatewayRouted: true,
    logIds: ['log-1'],
    status: 'completed',
    costStatus: 'pending',
    elapsedMs: 12,
    startedAt: '2026-01-01T00:00:00.000Z'
  },
  applied: {
    model: CLEF.id,
    stateFormat: 'text',
    questionCount: 1,
    questionTypeCounts: { noul: 1, choice: 0, score: 0 },
    stateCharacterCount: 20
  }
};

function setup(
  overrides: {
    evaluate?: typeof import('../../../src/client/services/playground-api').evaluateChoices;
  } = {}
) {
  const models = ref<CatalogueModel[]>([CLEF, CLEF_FLASH]);
  const evaluate = overrides.evaluate ?? vi.fn(async () => RESPONSE);
  const panel = useEvaluateChoices({
    models,
    evaluate: evaluate as never,
    // Resolves polls immediately, so the cost-tracking path runs without real time passing.
    runOptions: { sleep: async () => undefined }
  });
  return { panel, models, evaluate };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn }));
});

describe('useEvaluateChoices question builder', () => {
  it('selects the first catalogue model so the form is usable immediately', () => {
    const { panel } = setup();
    expect(panel.model.value).toBe(CLEF.id);
  });

  it('adds a question of each type with usable defaults', () => {
    const { panel } = setup();
    panel.addQuestion('choice');
    panel.addQuestion('score');

    const added = panel.questions.value.slice(1);
    expect(added[0]?.question.type).toBe('choice');
    expect(added[1]?.question.type).toBe('score');
    // Both start at the provider's own floor, so a freshly added question is never one the model
    // would reject.
    expect(added[0]?.question.type === 'choice' && added[0].question.options).toHaveLength(
      MIN_EVALUATION_OPTIONS
    );
    expect(added[1]?.question.type === 'score' && added[1].question.legend).toHaveLength(
      MIN_EVALUATION_OPTIONS
    );
  });

  it('stops adding questions at the batching limit', () => {
    const { panel } = setup();
    for (let index = 0; index < MAX_EVALUATION_QUESTIONS + 3; index += 1) {
      panel.addQuestion();
    }
    expect(panel.questions.value).toHaveLength(MAX_EVALUATION_QUESTIONS);
    expect(panel.canAddQuestion.value).toBe(false);
  });

  it('reorders questions and ignores a move past either end', () => {
    const { panel } = setup();
    panel.addQuestion('choice');
    const [first, second] = panel.questions.value.map((entry) => entry.name);

    panel.moveQuestion(1, -1);
    expect(panel.questions.value.map((entry) => entry.name)).toEqual([second, first]);

    panel.moveQuestion(0, -1);
    expect(panel.questions.value.map((entry) => entry.name)).toEqual([second, first]);
  });

  // Carrying a legend onto a choice would build a shape the server refuses and the visitor never
  // knowingly wrote.
  it('replaces type-specific fields when a question changes type, keeping the instructions', () => {
    const { panel } = setup();
    panel.addQuestion('score');
    panel.questions.value = panel.questions.value.map((entry, index) =>
      index === 1
        ? { ...entry, question: { ...entry.question, instructions: 'How frustrated?' } }
        : entry
    );

    panel.changeQuestionType(1, 'choice');

    const changed = panel.questions.value[1];
    expect(changed?.question.type).toBe('choice');
    expect(changed?.question.instructions).toBe('How frustrated?');
    expect(changed?.question).not.toHaveProperty('legend');
  });

  it('refuses to shrink a choice or a legend below the model\u2019s own floor', () => {
    const { panel } = setup();
    panel.addQuestion('choice');
    panel.removeOption(1, 0);

    const question = panel.questions.value[1]?.question;
    expect(question?.type === 'choice' && question.options).toHaveLength(MIN_EVALUATION_OPTIONS);
  });
});

describe('useEvaluateChoices validation', () => {
  it('blocks a question name the provider would reject', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'my question', question: { type: 'noul', instructions: 'Urgent?' } }
    ];
    await nextTick();

    expect(panel.blockedReason.value).toContain('name');
    expect(panel.canEvaluate.value).toBe(false);
  });

  it('blocks two questions sharing a name', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'same', question: { type: 'noul', instructions: 'Urgent?' } },
      { name: 'same', question: { type: 'noul', instructions: 'Important?' } }
    ];
    await nextTick();

    expect(panel.blockedReason.value).toContain('same');
  });

  it('blocks a JSON state that does not parse, while typing', async () => {
    const { panel } = setup();
    panel.state.value = '{ broken';
    panel.stateFormat.value = 'json';
    await nextTick();

    expect(panel.blockedReason.value).toContain('valid JSON');
  });

  it('blocks a question with no instructions', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    await nextTick();

    expect(panel.blockedReason.value).toContain('instructions');
  });
});

describe('useEvaluateChoices request preview', () => {
  // The panel's strongest claim, made checkable rather than asserted in prose.
  it('shows the exact payload and contains nothing resembling a prompt', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();

    const preview = panel.requestPreview.value;
    expect(preview).toContain('"questions"');
    expect(preview).toContain('"noul"');
    expect(preview).not.toContain('prompt');
    expect(preview).not.toContain('system');
    expect(preview).not.toContain('temperature');
  });

  it('omits blank optional criteria rather than sending empty descriptions', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    await nextTick();

    expect(panel.requestPreview.value).not.toContain('"whenTrue"');
  });
});

describe('useEvaluateChoices runs', () => {
  it('posts the questions and keeps a snapshot for rendering the answers', async () => {
    const evaluate = vi.fn(async () => RESPONSE);
    const { panel } = setup({ evaluate: evaluate as never });

    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();
    await panel.run();

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(panel.result.value?.answers).toHaveLength(1);
    expect(panel.resultQuestions.value[0]?.name).toBe('urgent');
  });

  // Answers are rendered beside the question they answer, so a stale result would label an answer
  // with a question nobody asked.
  it('discards a displayed result when any question is edited', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();
    await panel.run();
    expect(panel.result.value).toBeDefined();

    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this important?' } }
    ];
    await nextTick();

    expect(panel.result.value).toBeUndefined();
  });

  it('discards a displayed result when the state changes', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();
    await panel.run();

    panel.state.value = 'A different ticket.';
    await nextTick();

    expect(panel.result.value).toBeUndefined();
  });

  // Two models' probabilities for one question are different judgements, not interchangeable ones.
  it('discards a displayed result when the model changes', async () => {
    const { panel } = setup();
    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();
    await panel.run();

    panel.model.value = CLEF_FLASH.id;
    await nextTick();

    expect(panel.result.value).toBeUndefined();
  });

  it('surfaces a server refusal as its own message', async () => {
    const evaluate = vi.fn(async () => {
      throw new ApiError(400, 'Request body must not contain "prompt".');
    });
    const { panel } = setup({ evaluate: evaluate as never });

    panel.state.value = 'A ticket.';
    panel.questions.value = [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } }
    ];
    await nextTick();
    await panel.run();

    expect(panel.error.value).toContain('prompt');
    expect(panel.result.value).toBeUndefined();
  });

  // Regression: the questions live in a `ref`, so its entries are reactive proxies.
  // `structuredClone` throws `DataCloneError` on those, which hung the panel mid-run and was only
  // caught in the browser. Loading a scenario and running it exercises both copy sites.
  it('copies reactive questions without choking on their proxies', async () => {
    const evaluate = vi.fn(async () => RESPONSE);
    const { panel } = setup({ evaluate: evaluate as never });

    panel.loadExample({
      state: 'A ticket.',
      stateFormat: 'text',
      questions: [
        {
          name: 'department',
          question: {
            type: 'choice',
            instructions: 'Which team?',
            options: [
              { name: 'BILLING', description: 'Payments.' },
              { name: 'ENGINEERING', description: 'Bugs.' }
            ]
          }
        }
      ]
    });
    await nextTick();
    await panel.run();

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(panel.error.value).toBeNull();
    expect(panel.result.value).toBeDefined();
  });

  it('loads a prepared scenario without sharing its question objects', async () => {
    const { panel } = setup();
    const example = {
      state: 'A ticket.',
      stateFormat: 'text' as const,
      questions: [{ name: 'urgent', question: { type: 'noul' as const, instructions: 'Urgent?' } }]
    };

    panel.loadExample(example);
    await nextTick();
    panel.questions.value = panel.questions.value.map((entry) => ({ ...entry, name: 'renamed' }));

    // Editing a loaded scenario must not mutate the shared example, which would change what the
    // button loads next time.
    expect(example.questions[0]?.name).toBe('urgent');
  });
});
