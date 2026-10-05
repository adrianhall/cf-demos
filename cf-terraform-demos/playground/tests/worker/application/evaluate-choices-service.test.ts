import { beforeEach, describe, expect, it } from 'vitest';
import { EvaluateChoicesService } from '../../../src/worker/application/evaluate-choices/evaluate-choices-service';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { validateEvaluateChoicesRequest } from '../../../src/worker/domain/evaluate-choices';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

const [CLEF] = modelsForTask('evaluate-choices');
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

const QUESTIONS = [
  {
    name: 'urgent',
    question: {
      type: 'noul',
      instructions: 'Is this ticket urgent?',
      whenTrue: 'Blocks the customer.',
      whenFalse: 'Can wait.'
    }
  },
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
];

/**
 * A real two-question response captured from `@cf/cloudflare/clef-flash`.
 */
const LIVE_OUTPUT = {
  model: 'clef',
  answers: {
    urgent: { type: 'noul', noul: 0.9613 },
    department: {
      type: 'choice',
      choice: 'ENGINEERING',
      probabilities: { BILLING: 0.0565, ENGINEERING: 0.9346 },
      confidence: 0.815
    }
  },
  usage: { input_tokens: 158, output_tokens: 0 }
};

function build(options: FakeInferenceOptions = {}): {
  service: EvaluateChoicesService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({ output: () => LIVE_OUTPUT, ...options });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const runs = createMemoryRunRepository(now);

  return {
    service: new EvaluateChoicesService({ inference, runs, logger, now }),
    inference,
    runs,
    logs: capture
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return validateEvaluateChoicesRequest({
    state: 'The checkout page returns a 500 error and blocks my launch.',
    stateFormat: 'text',
    questions: QUESTIONS,
    model: CLEF?.id,
    runId: RUN_ID,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('EvaluateChoicesService', () => {
  // The panel's defining cost property: the question count does not change the call count.
  it('answers every question in exactly one gateway call', async () => {
    const { service, inference } = build();
    const response = await service.evaluate(request(), ACTOR);

    expect(inference.requests).toHaveLength(1);
    expect(response.result.answers).toHaveLength(2);
    expect(response.receipt.logIds).toEqual(['log-1']);
    expect(response.applied.questionCount).toBe(2);
  });

  it('sends the typed schema and nothing resembling a prompt', async () => {
    const { service, inference } = build();
    await service.evaluate(request(), ACTOR);

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(['model', 'questions', 'state']);
    expect(input).not.toHaveProperty('prompt');
    expect(input).not.toHaveProperty('messages');
    expect(input).not.toHaveProperty('response_format');
  });

  it('records the run against the verified identity for a later metrics lookup', async () => {
    const { service, runs } = build();
    await service.evaluate(request(), ACTOR);

    const record = await runs.find(RUN_ID);
    expect(record?.ownerEmail).toBe(ACTOR.email);
    expect(record?.task).toBe('evaluate-choices');
  });

  it('reports the model\u2019s own zero output tokens, which is the pricing lesson', async () => {
    const { service } = build();
    const response = await service.evaluate(request(), ACTOR);

    expect(response.result.usage).toEqual({ inputTokens: 158, outputTokens: 0 });
  });

  // Survivable degradation: the other questions were asked, paid for, and answered correctly.
  it('keeps usable answers when one question comes back unreadable, and warns', async () => {
    const { service, logs } = build({
      output: () => ({
        answers: {
          urgent: { type: 'noul', noul: 0.9 },
          department: { type: 'noul', noul: 0.4 }
        },
        usage: { input_tokens: 100, output_tokens: 0 }
      })
    });

    const response = await service.evaluate(request(), ACTOR);

    expect(response.result.answers).toHaveLength(1);
    expect(response.result.unansweredQuestions).toEqual(['department']);
    expect(logs.entries.map((entry) => entry.message)).toContain(
      'evaluate_choices_answers_incomplete'
    );
  });

  it('fails the run when no answer is usable, rather than showing an empty result', async () => {
    const { service, logs } = build({
      output: () => ({ answers: { urgent: { type: 'choice', choice: 'X' } } })
    });

    await expect(service.evaluate(request(), ACTOR)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });
    expect(logs.entries.map((entry) => entry.message)).toContain(
      'evaluate_choices_output_unusable'
    );
  });

  it('logs neither the state, the question wording, nor the verified email', async () => {
    const { service, logs } = build({ output: () => ({ nonsense: true }) });

    await expect(service.evaluate(request(), ACTOR)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });

    const text = logs.text();
    expect(text).not.toContain('checkout page');
    expect(text).not.toContain('Is this ticket urgent?');
    expect(text).not.toContain(ACTOR.email);
    // The shape is recorded even though the content is not, which is what makes a failure
    // diagnosable without disclosing anything.
    expect(text).toContain('questionTypeCounts');
  });
});
