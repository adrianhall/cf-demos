import { beforeEach, describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { ClassifyTextService } from '../../../src/worker/application/classify-text/classify-text-service';
import type { RunRepositoryPort } from '../../../src/worker/application/ports/run-repository-port';
import { validateClassifyTextRequest } from '../../../src/worker/domain/classify-text';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture } from '../support/mount';

/**
 * The reviewed text classifiers, in catalogue order.
 */
const [DISTILBERT, LLAMA_GUARD] = modelsForTask('classify-text');

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity runs are attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Builds the service with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to the scored-label envelope.
 * @returns The service, the fake port, the run repository, and the captured logs.
 */
function build(options: FakeInferenceOptions = {}): {
  service: ClassifyTextService;
  inference: FakeInference;
  runs: RunRepositoryPort;
  logs: ReturnType<typeof createLogCapture>['capture'];
} {
  const inference = new FakeInference({
    output: () => [
      { label: 'POSITIVE', score: 0.98 },
      { label: 'NEGATIVE', score: 0.02 }
    ],
    ...options
  });
  const { capture, logger } = createLogCapture();
  // One clock for both. The repository prunes records past its retention window, so a service
  // writing at an injected fixed time into a repository reading the real clock would have its
  // record expire the instant it was saved.
  const now = (): number => 1_000;
  const runs = createMemoryRunRepository(now);

  return {
    service: new ClassifyTextService({ inference, runs, logger, now }),
    inference,
    runs,
    logs: capture
  };
}

/**
 * Validates a request body, so the service receives the type it requires.
 *
 * @param overrides Fields to replace or add.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}) {
  return validateClassifyTextRequest({
    text: 'The staff were wonderful.',
    model: DISTILBERT!.id,
    runId: RUN_ID,
    ...overrides
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('classifying text', () => {
  it('returns the outcome, a receipt, and the applied controls', async () => {
    const { service } = build();
    const result = await service.classify(request(), ACTOR);

    expect(result.outcome.kind).toBe('scored-labels');
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'classify-text',
      model: DISTILBERT!.id,
      gatewayRouted: true,
      status: 'completed'
    });
    expect(result.applied.labelSetName).toBe('Sentiment (SST-2)');
  });

  it('routes the call through the gateway with the panel\u2019s task identifier', async () => {
    const { service, inference } = build();
    await service.classify(request(), ACTOR);

    expect(inference.requests[0]).toMatchObject({ task: 'classify-text', model: DISTILBERT });
  });

  it('attributes the run to the verified actor', async () => {
    const { service, inference } = build();
    await service.classify(request(), ACTOR);

    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  it('persists the run record before returning', async () => {
    const { service, runs } = build();
    await service.classify(request(), ACTOR);

    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'classify-text',
      ownerEmail: ACTOR.email,
      status: 'completed'
    });
  });

  it('makes exactly one inference call', async () => {
    const { service, inference } = build();
    await service.classify(request(), ACTOR);

    expect(inference.requests).toHaveLength(1);
  });
});

describe('the two outcome shapes', () => {
  it('produces a ranking for the scoring model', async () => {
    const { service } = build();
    const result = await service.classify(request(), ACTOR);

    if (result.outcome.kind !== 'scored-labels') {
      throw new Error('expected a scored outcome');
    }
    expect(result.outcome.labels[0]?.name).toBe('Positive');
    expect(result.outcome.totalLabels).toBe(2);
  });

  it('produces a verdict for the safety model', async () => {
    const { service } = build({
      output: () => ({ response: { safe: false, categories: ['S10'] } })
    });
    const result = await service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR);

    if (result.outcome.kind !== 'verdict') {
      throw new Error('expected a verdict outcome');
    }
    expect(result.outcome.verdict.safe).toBe(false);
    expect(result.outcome.verdict.categories[0]?.name).toBe('Hate');
  });

  // The whole reason the outcome is a union: a verdict has no score, and inventing one would be
  // the most misleading thing the panel could do.
  it('never attaches a score to a verdict', async () => {
    const { service } = build({
      output: () => ({ response: { safe: true, categories: [] } })
    });
    const result = await service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR);

    expect(JSON.stringify(result.outcome)).not.toContain('score');
  });

  it('sends each model its own request shape', async () => {
    const scored = build();
    await scored.service.classify(request(), ACTOR);
    expect(scored.inference.requests[0]?.input).toEqual({ text: 'The staff were wonderful.' });

    const verdict = build({ output: () => ({ response: { safe: true } }) });
    await verdict.service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR);
    expect(verdict.inference.requests[0]?.input).toEqual({
      messages: [{ role: 'user', content: 'The staff were wonderful.' }],
      // Without this the model answers with prose and the run fails; see the domain tests.
      response_format: { type: 'json_object' }
    });
  });
});

describe('refusing unusable output', () => {
  it('rejects a response in the wrong shape for the selected model', async () => {
    const { service } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('rejects a response with no usable labels', async () => {
    const { service } = build({ output: () => [{ nonsense: true }] });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  // The safety-relevant refusal. Saying "try again" would invite someone to spend credit until
  // the model happens to answer in the structured shape.
  it('refuses a prose safety verdict and says a different model is needed', async () => {
    const { service } = build({ output: () => ({ response: 'safe' }) });

    await expect(service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR)).rejects.toThrow(
      /will not infer a safety decision from prose/u
    );
  });

  it('says retrying will not help for a contract fault', async () => {
    const { service } = build({ output: () => ({ response: { categories: [] } }) });

    await expect(service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR)).rejects.toThrow(
      /unlikely to help/u
    );
  });

  it('does not persist a run record for a refused output', async () => {
    const { service, runs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });

  it('records the refusal reason and the expected shape', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    const refused = logs.entries.find((entry) => entry.message === 'classify_text_output_unusable');
    expect(refused?.context).toMatchObject({
      reason: 'unrecognised_shape',
      runId: RUN_ID,
      expectedOutcomeKind: 'scored-labels'
    });
  });
});

describe('partial degradation', () => {
  // A skipped element leaves the visitor with a shorter list and nothing on screen explaining
  // why, so the skip has to be recorded even though the run succeeds.
  it('succeeds but logs when some elements were skipped', async () => {
    const { service, logs } = build({
      output: () => [{ label: 'POSITIVE', score: 0.9 }, 'not an object']
    });

    const result = await service.classify(request(), ACTOR);
    expect(result.outcome.kind).toBe('scored-labels');

    const skipped = logs.entries.find(
      (entry) => entry.message === 'classify_text_elements_skipped'
    );
    expect(skipped?.context).toMatchObject({ returned: 2, skipped: 1, runId: RUN_ID });
  });

  it('logs nothing about skipping when every element was usable', async () => {
    const { service, logs } = build();
    await service.classify(request(), ACTOR);

    expect(logs.entries.some((entry) => entry.message === 'classify_text_elements_skipped')).toBe(
      false
    );
  });
});

describe('the run receipt', () => {
  it('marks the cost pending when a gateway log exists', async () => {
    const { service } = build({ logId: 'log-x' });
    const result = await service.classify(request(), ACTOR);

    expect(result.receipt.logIds).toEqual(['log-x']);
    expect(result.receipt.costStatus).toBe('pending');
  });

  // A run with no log will never resolve a cost, so it must not be reported as pending.
  it('does not mark the cost pending when no log was assigned', async () => {
    const { service } = build({ logId: null });
    const result = await service.classify(request(), ACTOR);

    expect(result.receipt.logIds).toEqual([]);
    expect(result.receipt.costStatus).not.toBe('pending');
  });
});

describe('provider failures', () => {
  it('propagates a sanitised provider failure', async () => {
    const { service } = build({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });

    await expect(service.classify(request(), ACTOR)).rejects.toThrow(ProblemDetailsError);
  });

  it('does not persist a run record for a failed call', async () => {
    const { service, runs } = build({ failWith: new Error('upstream failure') });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    expect(await runs.find(RUN_ID)).toBeUndefined();
  });
});

describe('privacy', () => {
  it('never logs the submitted text', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await service
      .classify(request({ text: 'my confidential sentence' }), ACTOR)
      .catch(() => undefined);

    expect(logs.text()).not.toContain('my confidential sentence');
  });

  // For a safety model the cited categories are a judgement about the visitor's own text, which
  // belongs in gateway metadata rather than a structured log.
  it('never logs the cited safety categories', async () => {
    const { service, logs } = build({
      output: () => ({ response: { safe: false, categories: ['S10', 'S1'] } })
    });
    await service.classify(request({ model: LLAMA_GUARD!.id }), ACTOR);

    expect(logs.text()).not.toContain('S10');
    expect(logs.text()).not.toContain('Hate');
  });

  it('never logs the verified email', async () => {
    const { service, logs } = build({ output: () => ({ unexpected: 'envelope' }) });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    expect(logs.text()).not.toContain(ACTOR.email);
  });
});
