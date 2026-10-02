/**
 * @file Use-case tests for Classify Image. The interesting surface here is the output normaliser.
 *   Every earlier panel read a value out of an envelope; this one reads a _collection_, so the
 *   failures are structural — an element that is not an object, a score that is not a number, a
 *   score outside the range a proportion can occupy. Each of those would reach the browser as a
 *   rendering artefact rather than an error, which is why they are refused here and asserted on.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ClassifyImageService } from '../../../src/worker/application/classify-image/classify-image-service';
import {
  validateClassifyImageRequest,
  type ValidatedClassifyImageRequest
} from '../../../src/worker/domain/classify-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';
import { problemWithStatus } from '../support/problem-details';

/**
 * The reviewed classifier.
 */
const RESNET = modelsForTask('classify-image')[0]!;

/**
 * The verified actor every call is attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * A plausible classifier response.
 */
const SCORED = [
  { label: 'tabby', score: 0.4 },
  { label: 'Egyptian cat', score: 0.52 },
  { label: 'lynx', score: 0.03 }
];

/**
 * Records every log a service emitted, so a test can assert on what was _not_ logged.
 *
 * @returns The recorded entries, a logger writing into them, and their serialised form.
 */
function createRecorder(): {
  entries: { level: string; message: string; context?: Record<string, unknown> }[];
  logger: { warn: typeof console.warn; error: typeof console.error };
  text: () => string;
} {
  const entries: { level: string; message: string; context?: Record<string, unknown> }[] = [];
  return {
    entries,
    logger: {
      warn: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: 'warn', message, context });
      },
      error: (message: string, context?: Record<string, unknown>) => {
        entries.push({ level: 'error', message, context });
      }
    } as never,
    text: () => JSON.stringify(entries)
  };
}

/**
 * Builds a validated request, going through real validation rather than hand-building the type.
 *
 * @param overrides Extra body fields.
 * @returns The validated request.
 */
function request(overrides: Record<string, unknown> = {}): ValidatedClassifyImageRequest {
  return validateClassifyImageRequest({
    imageBase64: pngBase64(120, 80),
    model: RESNET.id,
    runId: RUN_ID,
    ...overrides
  });
}

describe('classifying a picture', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it('returns the labels ranked highest score first', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.labels.map((entry) => entry.label)).toEqual(['Egyptian cat', 'tabby', 'lynx']);
  });

  // The count the panel needs in order to say "showing 3 of the 5 labels this model returned"
  // instead of implying the model was asked for three.
  it('reports how many labels the model returned before filtering', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request({ topK: 1 }), ACTOR);
    expect(result.labels).toHaveLength(1);
    expect(result.totalLabels).toBe(3);
  });

  it('applies the confidence floor the caller set', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request({ minimumConfidence: 0.3 }), ACTOR);
    expect(result.labels.map((entry) => entry.label)).toEqual(['Egyptian cat', 'tabby']);
  });

  // The model answered; the visitor hid everything it said. That is a successful run with an empty
  // ranking, not a failure, and collapsing the two would make a raised threshold look like a bug.
  it('succeeds with an empty ranking when nothing clears the floor', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request({ minimumConfidence: 0.99 }), ACTOR);
    expect(result.labels).toEqual([]);
    expect(result.totalLabels).toBe(3);
    expect(result.receipt.status).toBe('completed');
  });

  it('returns the facts the server verified about the picture', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.image).toMatchObject({ mediaType: 'image/png', width: 120, height: 80 });
  });

  it('reports the controls that were applied, including model defaults', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.applied).toMatchObject({
      model: RESNET.id,
      topK: RESNET.classificationControls?.topK?.default
    });
  });
});

describe('unusable provider output', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it.each([
    ['an object instead of an array', () => ({ labels: SCORED })],
    ['a string', () => 'tabby'],
    ['a null output', () => null],
    ['an empty array', () => []],
    ['an array of non-objects', () => ['tabby', 'lynx']],
    ['labels with no score', () => [{ label: 'tabby' }]],
    ['scores with no label', () => [{ score: 0.5 }]],
    ['a non-numeric score', () => [{ label: 'tabby', score: 'high' }]],
    ['a blank label', () => [{ label: '   ', score: 0.5 }]]
  ])('refuses %s with a 502', async (_label, output) => {
    const inference = new FakeInference({ output });
    const service = new ClassifyImageService({ inference, runs });

    await expect(service.classify(request(), ACTOR)).rejects.toMatchObject(problemWithStatus(502));
  });

  // A score outside 0–1 is the one value this panel renders as a proportion, so an out-of-range
  // number would paint a bar outside its own track rather than merely reading oddly.
  it.each([-0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a score of %s',
    async (score) => {
      const inference = new FakeInference({ output: () => [{ label: 'tabby', score }] });
      const service = new ClassifyImageService({ inference, runs });

      await expect(service.classify(request(), ACTOR)).rejects.toMatchObject(
        problemWithStatus(502)
      );
    }
  );

  // One malformed element out of several is a provider quirk rather than a contract change, so
  // the run still produces a result — and the skip is recorded so it is visible if it becomes
  // routine.
  it('skips a single malformed element and still returns a ranking', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({
      output: () => [{ label: 'tabby', score: 0.4 }, { label: 'broken' }, null]
    });
    const service = new ClassifyImageService({
      inference,
      runs,
      logger: recorder.logger as never
    });

    const result = await service.classify(request(), ACTOR);
    expect(result.labels.map((entry) => entry.label)).toEqual(['tabby']);
    expect(result.totalLabels).toBe(1);

    const skipped = recorder.entries.find(
      (entry) => entry.message === 'classify_image_labels_skipped'
    );
    expect(skipped?.context).toMatchObject({ skipped: 2, usable: 1 });
  });

  // A refusal here looks identical to a provider error from the browser's point of view — both
  // are a 502 — so without this line the two are indistinguishable in an incident, and they have
  // completely different fixes.
  it('logs a refusal with a reason and the shape that arrived', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({ output: () => ({ predictions: SCORED }) });
    const service = new ClassifyImageService({
      inference,
      runs,
      logger: recorder.logger as never
    });

    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    const entry = recorder.entries.find(
      (item) => item.message === 'classify_image_output_unusable'
    );
    expect(entry?.context).toMatchObject({
      reason: 'unrecognised_shape',
      runId: RUN_ID,
      outputKeys: ['predictions']
    });
  });

  it('distinguishes an empty result from one with no usable labels', async () => {
    const recorder = createRecorder();
    const service = new ClassifyImageService({
      inference: new FakeInference({ output: () => [] }),
      runs,
      logger: recorder.logger as never
    });
    await expect(service.classify(request(), ACTOR)).rejects.toThrow();
    expect(recorder.entries[0]?.context).toMatchObject({ reason: 'empty_result' });

    const second = createRecorder();
    const other = new ClassifyImageService({
      inference: new FakeInference({ output: () => [{ nonsense: true }] }),
      runs,
      logger: second.logger as never
    });
    await expect(other.classify(request(), ACTOR)).rejects.toThrow();
    expect(second.entries[0]?.context).toMatchObject({ reason: 'no_usable_labels' });
  });

  // A label is model output about the visitor's picture. The keys of a broken envelope are
  // diagnostic; the values would put that content in a Worker log.
  it('never logs a label or the verified email', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({
      output: () => ({ predictions: [{ label: 'a confidential whiteboard', score: 0.9 }] })
    });
    const service = new ClassifyImageService({
      inference,
      runs,
      logger: recorder.logger as never
    });

    await expect(service.classify(request(), ACTOR)).rejects.toThrow();

    expect(recorder.text()).not.toContain('confidential whiteboard');
    expect(recorder.text()).not.toContain(ACTOR.email);
  });

  // A run the visitor cannot be shown is a run that should not appear in the ledger either. Uses
  // its own identifier because the repository's map is module-scoped by design, so a shared one
  // would find a record written by an earlier test and pass for the wrong reason.
  it('does not record a run for a refused output', async () => {
    const refusedRunId = 'refused-classify-run-01';
    const inference = new FakeInference({ output: () => ({}) });
    const service = new ClassifyImageService({ inference, runs });

    await expect(service.classify(request({ runId: refusedRunId }), ACTOR)).rejects.toThrow();
    expect(await runs.find(refusedRunId)).toBeUndefined();
  });
});

describe('the gateway call', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it('routes through the inference port with this panel\u2019s task identifier', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    await service.classify(request(), ACTOR);
    expect(inference.requests[0]?.task).toBe('classify-image');
  });

  // The attribution rule, asserted at the boundary where it would actually be broken: the actor
  // reaching the gateway must be the verified one, never a value from a request.
  it('attributes the call to the verified actor', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    await service.classify(request(), ACTOR);
    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  it('sends the picture as the reviewed schema expects and nothing more', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    await service.classify(request({ topK: 2, minimumConfidence: 0.1 }), ACTOR);

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(['image']);
    expect(Array.isArray(input['image'])).toBe(true);
  });

  it('propagates a provider failure unchanged', async () => {
    const inference = new FakeInference({ failWith: new Error('provider exploded') });
    const service = new ClassifyImageService({ inference, runs });

    await expect(service.classify(request(), ACTOR)).rejects.toThrow('provider exploded');
  });
});

describe('the run receipt', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  // Unlike Remix Image's FLUX path, this panel has no gateway exception: the classifier takes an
  // ordinary JSON body, so every run is routed and costed.
  it('reports the run as gateway-routed and completed', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'classify-image',
      gatewayRouted: true,
      status: 'completed'
    });
  });

  it('marks the cost pending when a gateway log exists to poll for', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.receipt.costStatus).toBe('pending');
    expect(result.receipt.logIds).toHaveLength(1);
  });

  // A run with no gateway log will never resolve a cost, so claiming it is pending would leave the
  // meter waiting for something that is never coming.
  it('does not mark the cost pending when no log was assigned', async () => {
    const inference = new FakeInference({ output: () => SCORED, logId: null });
    const service = new ClassifyImageService({ inference, runs });

    const result = await service.classify(request(), ACTOR);
    expect(result.receipt.costStatus).not.toBe('pending');
    expect(result.receipt.logIds).toHaveLength(0);
  });

  // Written before the method returns, so there is no window in which the browser holds a receipt
  // the server cannot resolve.
  it('records the run against the verified owner before returning', async () => {
    const inference = new FakeInference({ output: () => SCORED });
    const service = new ClassifyImageService({ inference, runs });

    await service.classify(request(), ACTOR);
    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'classify-image',
      ownerEmail: ACTOR.email
    });
  });
});
