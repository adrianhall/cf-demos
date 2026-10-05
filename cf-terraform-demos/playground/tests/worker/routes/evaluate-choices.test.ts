import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { EvaluateChoicesResponse } from '../../../src/shared/evaluate-choices';
import { EvaluateChoicesService } from '../../../src/worker/application/evaluate-choices/evaluate-choices-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { evaluateChoicesRouter } from '../../../src/worker/routes/evaluate-choices';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute } from '../support/mount';

const [CLEF] = modelsForTask('evaluate-choices');
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

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

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'The checkout page returns a 500 error.',
    stateFormat: 'text',
    questions: [
      { name: 'urgent', question: { type: 'noul', instructions: 'Is this urgent?' } },
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
    ],
    model: CLEF?.id,
    runId: 'a1b2c3d4-1111-4222-8333-444455556666',
    ...overrides
  };
}

function mount(options: FakeInferenceOptions = {}) {
  const inference = new FakeInference({ output: () => LIVE_OUTPUT, ...options });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new EvaluateChoicesService({
    inference,
    runs: createMemoryRunRepository(now),
    logger,
    now
  });

  const mounted = mountRoute('/api/evaluate-choices', evaluateChoicesRouter, {
    identity: IDENTITY,
    evaluateChoicesService: service,
    logger
  });

  return { app: mounted.app, inference, logs: capture };
}

async function post(
  app: ReturnType<typeof mount>['app'],
  request: Record<string, unknown>
): Promise<Response> {
  return app.request('/api/evaluate-choices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request)
  });
}

describe('the Evaluate Choices route', () => {
  it('returns typed answers with a receipt, logging shape but never content', async () => {
    const { app, inference, logs } = mount();
    const response = await post(app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as EvaluateChoicesResponse;

    expect(payload.receipt.task).toBe('evaluate-choices');
    expect(payload.result.answers).toHaveLength(2);
    expect(payload.applied.questionTypeCounts).toEqual({ noul: 1, choice: 1, score: 0 });
    // Two questions, one call.
    expect(inference.requests).toHaveLength(1);

    expect(logs.entries.map((entry) => entry.message)).toEqual([
      'evaluate_choices_run_started',
      'evaluate_choices_run_completed'
    ]);
    const text = logs.text();
    expect(text).not.toContain('checkout page');
    expect(text).not.toContain('Which team?');
    expect(text).not.toContain(IDENTITY.email);
  });

  it('refuses a prompt before reaching inference, naming the Chat panel instead', async () => {
    const { app, inference } = mount();
    const response = await post(app, body({ prompt: 'Judge this ticket.' }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Chat panel');
    expect(inference.requests).toEqual([]);
  });

  it('refuses an unparseable JSON state before reaching inference', async () => {
    const { app, inference } = mount();
    const response = await post(app, body({ stateFormat: 'json', state: '{ broken' }));

    expect(response.status).toBe(400);
    expect(inference.requests).toEqual([]);
  });

  it('logs the attempt before calling the model, so a failure is still diagnosable', async () => {
    const { app, logs } = mount({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });
    const response = await post(app, body());

    expect(response.status).toBe(502);
    // Both lines carry the run identifier, so one search returns the whole story of the attempt.
    const messages = logs.entries.map((entry) => entry.message);
    expect(messages).toContain('evaluate_choices_run_started');
    expect(messages).toContain('evaluate_choices_run_failed');
  });

  it('leaks neither provider internals nor a stack trace when inference fails', async () => {
    const { app } = mount({
      failWith: new Error('upstream: host internal-host-7 rejected "my secret"')
    });
    const text = await (await post(app, body())).text();

    expect(text).not.toContain('my secret');
    expect(text).not.toContain('internal-host-7');
    expect(text).not.toMatch(/\n\s*at\s/u);
  });
});
