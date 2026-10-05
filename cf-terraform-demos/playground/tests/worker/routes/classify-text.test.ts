import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import {
  MAX_CLASSIFICATION_TEXT_CHARACTERS,
  type ClassifyTextResponse
} from '../../../src/shared/classify-text';
import { ClassifyTextService } from '../../../src/worker/application/classify-text/classify-text-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  CLASSIFY_TEXT_BODY_LIMIT_BYTES,
  classifyTextRouter
} from '../../../src/worker/routes/classify-text';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed text classifiers, in catalogue order.
 */
const [DISTILBERT, LLAMA_GUARD, CLEF_FLASH] = modelsForTask('classify-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Mounts the Classify Text router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to the scored-label envelope.
 * @returns The app, the fake inference port, and the captured logs.
 */
function mount(options: FakeInferenceOptions = {}): {
  app: ReturnType<typeof mountRoute>['app'];
  inference: FakeInference;
  logs: LogCapture;
} {
  const inference = new FakeInference({
    output: () => [
      { label: 'POSITIVE', score: 0.98 },
      { label: 'NEGATIVE', score: 0.02 }
    ],
    ...options
  });
  const { capture, logger } = createLogCapture();
  const now = (): number => 1_000;
  const service = new ClassifyTextService({
    inference,
    runs: createMemoryRunRepository(now),
    logger,
    now
  });

  const mounted = mountRoute('/api/classify-text', classifyTextRouter, {
    identity: IDENTITY,
    classifyTextService: service,
    logger
  });
  mounted.app.onError(problemDetailsErrorHandler({ includeStack: false }));

  return { app: mounted.app, inference, logs: capture };
}

/**
 * Builds a valid request body.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'The staff were wonderful.',
    model: DISTILBERT!.id,
    runId: RUN_ID,
    ...overrides
  };
}

/**
 * Posts a body to the route.
 *
 * @param app The mounted app.
 * @param payload Body to send.
 * @returns The response.
 */
async function post(
  app: ReturnType<typeof mountRoute>['app'],
  payload: unknown
): Promise<Response> {
  return app.request('/api/classify-text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('classifying text', () => {
  it('returns the outcome, a receipt, and the applied controls', async () => {
    const response = await post(mount().app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ClassifyTextResponse;
    expect(payload.outcome.kind).toBe('scored-labels');
    expect(payload.receipt.runId).toBe(RUN_ID);
    expect(payload.applied.labelSetName).toBe('Sentiment (SST-2)');
  });

  it('returns a ranked list with reviewed names', async () => {
    const payload = (await (await post(mount().app, body())).json()) as ClassifyTextResponse;

    if (payload.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }
    expect(payload.outcome.labels[0]).toMatchObject({ rank: 1, name: 'Positive' });
  });

  it('returns a three-way sentiment ranking from Clef Flash', async () => {
    const { app, inference } = mount({
      output: () => ({
        model: 'clef-flash',
        answers: {
          sentiment: {
            type: 'choice',
            choice: 'NEUTRAL',
            probabilities: { POSITIVE: 0.1, NEGATIVE: 0.1, NEUTRAL: 0.8 },
            confidence: 0.7
          }
        },
        usage: { input_tokens: 10, output_tokens: 0 }
      })
    });
    const payload = (await (
      await post(app, body({ model: CLEF_FLASH!.id }))
    ).json()) as ClassifyTextResponse;

    expect(payload.outcome.kind).toBe('scored-labels');
    if (payload.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }
    expect(payload.outcome.labels[0]).toMatchObject({ label: 'NEUTRAL', score: 0.8 });
    expect(inference.requests[0]?.input).toMatchObject({
      model: 'clef-flash',
      state: 'The staff were wonderful.'
    });
  });

  it('returns a verdict for the safety model', async () => {
    const { app } = mount({ output: () => ({ response: { safe: true, categories: [] } }) });
    const payload = (await (
      await post(app, body({ model: LLAMA_GUARD!.id }))
    ).json()) as ClassifyTextResponse;

    expect(payload.outcome.kind).toBe('verdict');
  });

  it('applies the ranking controls to the response', async () => {
    const { app } = mount();
    const payload = (await (await post(app, body({ topK: 1 }))).json()) as ClassifyTextResponse;

    if (payload.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }
    expect(payload.outcome.labels).toHaveLength(1);
    // The pre-filter count, so the panel can say what was hidden.
    expect(payload.outcome.totalLabels).toBe(2);
  });

  // Neither model has a ranking field in its schema, so the controls must not reach the provider.
  it('never forwards a ranking control to the provider', async () => {
    const { app, inference } = mount();
    await post(app, body({ topK: 1, minimumConfidence: 0.5 }));

    expect(inference.requests[0]?.input).toEqual({ text: 'The staff were wonderful.' });
  });
});

/**
 * The regression guard the phase brief asks for, at the HTTP boundary.
 */
describe('rejecting caller-defined criteria', () => {
  it('rejects a body supplying its own labels or questions', async () => {
    for (const field of ['labels', 'categories', 'criteria', 'question', 'choices']) {
      const response = await post(mount().app, body({ [field]: ['mine'] }));
      expect(response.status, `${field} is refused`).toBe(400);
    }
  });

  it('explains that the labels belong to the model and names the other panel', async () => {
    const response = await post(mount().app, body({ labels: ['urgent'] }));
    const problem = (await response.json()) as { detail: string };

    expect(problem.detail).toMatch(/cannot be supplied by the caller/u);
    expect(problem.detail).toMatch(/Evaluate Choices/u);
  });

  it('refuses before making any call', async () => {
    const { app, inference } = mount();
    await post(app, body({ labels: ['urgent'] }));

    expect(inference.requests).toHaveLength(0);
  });
});

describe('rejected requests', () => {
  it('rejects a body carrying an identity field', async () => {
    expect((await post(mount().app, body({ email: 'mallory@example.com' }))).status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    expect((await post(mount().app, body({ model: '@cf/meta/m2m100-1.2b' }))).status).toBe(400);
  });

  it('rejects empty text', async () => {
    expect((await post(mount().app, body({ text: '   ' }))).status).toBe(400);
  });

  it('rejects text beyond the character limit', async () => {
    const long = 'a'.repeat(MAX_CLASSIFICATION_TEXT_CHARACTERS + 1);
    expect((await post(mount().app, body({ text: long }))).status).toBe(400);
  });

  it('rejects a control outside the declared range', async () => {
    expect((await post(mount().app, body({ topK: 0 }))).status).toBe(400);
    expect((await post(mount().app, body({ minimumConfidence: 2 }))).status).toBe(400);
  });

  // There is no score in this model's output for the control to act on, so it is refused rather
  // than accepted and dropped.
  it('rejects a ranking control on the model that reports no scores', async () => {
    const response = await post(mount().app, body({ model: LLAMA_GUARD!.id, topK: 1 }));
    const problem = (await response.json()) as { detail: string };

    expect(response.status).toBe(400);
    expect(problem.detail).toMatch(/nothing to rank or filter/u);
  });

  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way.
  it('refuses a body beyond the transport limit', async () => {
    const { app } = mount();
    const oversized = 'x'.repeat(CLASSIFY_TEXT_BODY_LIMIT_BYTES + 1_024);
    const response = await app.request('/api/classify-text', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(oversized.length)
      },
      body: oversized
    });

    expect(response.status).toBe(400);
  });

  // Derived from the character ceiling rather than hard-coded, so raising that limit cannot
  // silently leave this behind.
  it('sizes the body limit to hold the longest accepted text', () => {
    expect(CLASSIFY_TEXT_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_CLASSIFICATION_TEXT_CHARACTERS * 4);
  });

  it('returns a sanitised 502 when the provider fails', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });

    expect((await post(app, body())).status).toBe(502);
  });

  it('returns a 502 when the provider returns an unusable envelope', async () => {
    const { app } = mount({ output: () => ({ unexpected: 'envelope' }) });
    expect((await post(app, body())).status).toBe(502);
  });

  // A third-party classifier added later would make this reachable. The classification already
  // works because it is decided in the inference client, below this route.
  it('passes through a 503 when gateway credit is insufficient', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 503,
        title: 'AI Gateway credits are unavailable',
        detail: 'This model uses prepaid AI Gateway credits.'
      })
    });

    expect((await post(app, body())).status).toBe(503);
  });

  it('leaks neither provider internals nor a stack trace', async () => {
    const { app } = mount({
      failWith: new Error('upstream: host internal-host-7 rejected "my secret"')
    });
    const text = await (await post(app, body())).text();

    expect(text).not.toContain('my secret');
    expect(text).not.toContain('internal-host-7');
    expect(text).not.toMatch(/\n\s*at\s/u);
  });
});

describe('diagnostics', () => {
  it('logs the attempt before calling the model', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const started = logs.entries.find((entry) => entry.message === 'classify_text_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: DISTILBERT!.id,
      expectedOutcomeKind: 'scored-labels'
    });
  });

  it('records the controls that were in force, including defaults', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const started = logs.entries.find((entry) => entry.message === 'classify_text_run_started');
    expect(started?.context).toMatchObject({ topK: 2, minimumConfidence: 0 });
  });

  // Null rather than omitted, so a log search for the key does not imply a bug when the model
  // simply has no such control.
  it('records null controls for the model that has none', async () => {
    const { app, logs } = mount({ output: () => ({ response: { safe: true } }) });
    await post(app, body({ model: LLAMA_GUARD!.id }));

    const started = logs.entries.find((entry) => entry.message === 'classify_text_run_started');
    expect(started?.context?.['topK']).toBeNull();
    expect(started?.context?.['minimumConfidence']).toBeNull();
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'classify_text_run_started')).toBe(true);
    expect(logs.entries.some((entry) => entry.message === 'classify_text_run_failed')).toBe(true);
  });

  // Two requests that look identical in an access log have to be distinguishable in the
  // structured logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) => entry.message.startsWith('classify_text_run'));
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  it('records the shape of the answer on success', async () => {
    const { app, logs } = mount();
    await post(app, body({ topK: 1 }));

    const completed = logs.entries.find((entry) => entry.message === 'classify_text_run_completed');
    expect(completed?.context).toMatchObject({
      outcomeKind: 'scored-labels',
      shownLabels: 1,
      totalLabels: 2
    });
  });

  it('records a verdict\u2019s category count without the categories', async () => {
    const { app, logs } = mount({
      output: () => ({ response: { safe: false, categories: ['S10'] } })
    });
    await post(app, body({ model: LLAMA_GUARD!.id }));

    const completed = logs.entries.find((entry) => entry.message === 'classify_text_run_completed');
    expect(completed?.context).toMatchObject({ outcomeKind: 'verdict', categoryCount: 1 });
    expect(logs.text()).not.toContain('S10');
  });

  // Written as "must not contain", because that is the direction that silently rots: a field
  // added later would pass a positive assertion while breaking this one.
  it('never logs the text, the labels, or the verified email', async () => {
    const { app, logs } = mount();
    await post(app, body({ text: 'my confidential sentence' }));

    expect(logs.text()).not.toContain('my confidential sentence');
    expect(logs.text()).not.toContain('POSITIVE');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });
});

describe('identity', () => {
  // The attribution rule, asserted where it would actually be broken.
  it('attributes the run to the verified identity rather than anything in the body', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(inference.requests[0]?.actor).toEqual(IDENTITY);
  });
});
