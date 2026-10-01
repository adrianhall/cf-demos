import { beforeEach, describe, expect, it } from 'vitest';
import { DescribeImageService } from '../../../src/worker/application/describe-image/describe-image-service';
import {
  validateDescribeImageRequest,
  type ValidatedDescribeImageRequest
} from '../../../src/worker/domain/describe-image';
import { modelsForTask } from '../../../src/worker/domain/models';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';
import { problemWithStatus } from '../support/problem-details';

/**
 * The reviewed model that returns its answer in `description`.
 */
const DESCRIPTION_MODEL = modelsForTask('describe-image').find(
  (model) => model.descriptionField === 'description'
)!;

/**
 * The reviewed model that returns its answer in `response`.
 */
const RESPONSE_MODEL = modelsForTask('describe-image').find(
  (model) => model.descriptionField === 'response'
)!;

/**
 * The verified actor every call is attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * A run identifier of the shape the browser generates.
 */
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Records every log a service emitted, so a test can assert on what was _not_ logged.
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
 * Builds a validated request for one model.
 *
 * Goes through real validation rather than hand-building the type, so the service is always
 * exercised against input shaped exactly as production would shape it.
 *
 * @param modelId Model to request.
 * @param overrides Extra body fields.
 * @returns The validated request.
 */
function request(
  modelId: string,
  overrides: Record<string, unknown> = {}
): ValidatedDescribeImageRequest {
  return validateDescribeImageRequest({
    imageBase64: pngBase64(120, 80),
    model: modelId,
    runId: RUN_ID,
    instruction: 'What is in this picture?',
    ...overrides
  });
}

describe('describing a picture', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  // The two reviewed models name their answer field differently. Reading the wrong one would
  // return nothing while the request itself succeeded.
  it('reads the answer from the field the model declares', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A red door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.description).toBe('A red door.');
  });

  it('reads the other model\u2019s field without needing a fallback', async () => {
    const inference = new FakeInference({ output: () => ({ response: 'A blue door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(RESPONSE_MODEL.id), ACTOR);
    expect(result.description).toBe('A blue door.');
  });

  // The important negative case. A fallback that tried each candidate key in turn would be more
  // forgiving and considerably worse: a contract change would silently return some other string
  // as the description rather than failing where someone would notice.
  it('refuses an answer in the other model\u2019s field rather than falling back', async () => {
    const inference = new FakeInference({ output: () => ({ response: 'Wrong field.' }) });
    const service = new DescribeImageService({ inference, runs });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toMatchObject(
      problemWithStatus(502)
    );
  });

  it('trims surrounding whitespace from the answer', async () => {
    const inference = new FakeInference({ output: () => ({ description: '  A door.\n' }) });
    const service = new DescribeImageService({ inference, runs });

    expect((await service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).description).toBe(
      'A door.'
    );
  });

  it('returns the facts the server verified about the picture', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.image).toMatchObject({ mediaType: 'image/png', width: 120, height: 80 });
  });
});

describe('unusable provider output', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it.each([
    ['a missing field', () => ({})],
    ['a non-string field', () => ({ description: 42 })],
    ['an empty description', () => ({ description: '   ' })],
    ['a non-object output', () => 'just a string'],
    ['a null output', () => null]
  ])('refuses %s with a 502', async (_label, output) => {
    const inference = new FakeInference({ output });
    const service = new DescribeImageService({ inference, runs });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toMatchObject(
      problemWithStatus(502)
    );
  });

  // A refusal here looks identical to a provider error from the browser's point of view — both
  // are a 502 — so without this line the two are indistinguishable in an incident, and they have
  // completely different fixes.
  it('logs a refusal with a reason and the keys that were present', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({ output: () => ({ caption: 'wrong envelope' }) });
    const service = new DescribeImageService({ inference, runs, logger: recorder.logger as never });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toThrow();

    const entry = recorder.entries.find(
      (item) => item.message === 'describe_image_output_unusable'
    );
    expect(entry).toBeDefined();
    expect(entry?.context).toMatchObject({
      reason: 'missing_field',
      expectedField: 'description',
      outputKeys: ['caption']
    });
  });

  it('distinguishes a missing field from a wrongly typed one', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({ output: () => ({ description: 42 }) });
    const service = new DescribeImageService({ inference, runs, logger: recorder.logger as never });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toThrow();
    expect(recorder.entries[0]?.context).toMatchObject({ reason: 'wrong_field_type' });
  });

  it('records an empty answer separately, since the contract was met', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({ output: () => ({ description: '' }) });
    const service = new DescribeImageService({ inference, runs, logger: recorder.logger as never });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toThrow();
    expect(recorder.entries[0]?.context).toMatchObject({ reason: 'empty_description' });
  });

  // The provider's own output could be anything, including the picture's description. Logging the
  // keys is diagnostic; logging the values would put the visitor's content in a Worker log.
  it('never logs the description text or the verified email', async () => {
    const recorder = createRecorder();
    const inference = new FakeInference({
      output: () => ({ caption: 'a photograph of a confidential whiteboard' })
    });
    const service = new DescribeImageService({ inference, runs, logger: recorder.logger as never });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toThrow();

    expect(recorder.text()).not.toContain('confidential whiteboard');
    expect(recorder.text()).not.toContain(ACTOR.email);
  });

  // A run the visitor cannot be shown is a run that should not appear in the ledger either. Uses
  // its own identifier because the repository's map is module-scoped by design, so a shared one
  // would find a record written by an earlier test and pass for the wrong reason.
  it('does not record a run for a refused output', async () => {
    const refusedRunId = 'refused-output-run-0001';
    const inference = new FakeInference({ output: () => ({}) });
    const service = new DescribeImageService({ inference, runs });

    await expect(
      service.describe(request(DESCRIPTION_MODEL.id, { runId: refusedRunId }), ACTOR)
    ).rejects.toThrow();
    expect(await runs.find(refusedRunId)).toBeUndefined();
  });
});

describe('the gateway call', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it('routes through the inference port with this panel\u2019s task identifier', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(inference.requests[0]?.task).toBe('describe-image');
  });

  // The attribution rule, asserted at the boundary where it would actually be broken: the actor
  // reaching the gateway must be the verified one, never a value from a request.
  it('attributes the call to the verified actor', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(inference.requests[0]?.actor).toEqual(ACTOR);
  });

  it('sends the picture and question as the reviewed schema expects', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    await service.describe(request(DESCRIPTION_MODEL.id, { instruction: 'What colour?' }), ACTOR);

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(Array.isArray(input['image'])).toBe(true);
    expect(input['prompt']).toBe('What colour?');
  });

  it('propagates a provider failure unchanged', async () => {
    const inference = new FakeInference({ failWith: new Error('provider exploded') });
    const service = new DescribeImageService({ inference, runs });

    await expect(service.describe(request(DESCRIPTION_MODEL.id), ACTOR)).rejects.toThrow(
      'provider exploded'
    );
  });
});

describe('the run receipt', () => {
  let runs: ReturnType<typeof createMemoryRunRepository>;

  beforeEach(() => {
    runs = createMemoryRunRepository();
  });

  it('reports the run as gateway-routed and completed', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.receipt).toMatchObject({
      runId: RUN_ID,
      task: 'describe-image',
      gatewayRouted: true,
      status: 'completed'
    });
  });

  it('marks the cost pending when a gateway log exists to poll for', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.receipt.costStatus).toBe('pending');
    expect(result.receipt.logIds).toHaveLength(1);
  });

  // A run with no gateway log will never resolve a cost, so claiming it is pending would leave the
  // meter waiting for something that is never coming.
  it('does not mark the cost pending when no log was assigned', async () => {
    const inference = new FakeInference({
      output: () => ({ description: 'A door.' }),
      logId: null
    });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.receipt.costStatus).not.toBe('pending');
    expect(result.receipt.logIds).toHaveLength(0);
  });

  // Written before the method returns, so there is no window in which the browser holds a receipt
  // the server cannot resolve.
  it('records the run against the verified owner before returning', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(await runs.find(RUN_ID)).toMatchObject({
      runId: RUN_ID,
      task: 'describe-image',
      ownerEmail: ACTOR.email
    });
  });

  it('reports the controls that were applied, including model defaults', async () => {
    const inference = new FakeInference({ output: () => ({ description: 'A door.' }) });
    const service = new DescribeImageService({ inference, runs });

    const result = await service.describe(request(DESCRIPTION_MODEL.id), ACTOR);
    expect(result.applied).toMatchObject({
      model: DESCRIPTION_MODEL.id,
      maxTokens: DESCRIPTION_MODEL.visionControls?.maxTokens?.default
    });
  });
});
