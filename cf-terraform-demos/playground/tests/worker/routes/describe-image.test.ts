import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import { MAX_INPUT_IMAGE_BYTES, type DescribeImageResponse } from '../../../src/describe-image';
import { DescribeImageService } from '../../../src/worker/application/describe-image/describe-image-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  DESCRIBE_IMAGE_BODY_LIMIT_BYTES,
  describeImageRouter
} from '../../../src/worker/routes/describe-image';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed model that will caption a bare picture.
 */
const CAPTIONS_ALONE = modelsForTask('describe-image').find(
  (model) => model.visionControls?.instructionRequired === false
)!;

/**
 * The reviewed model that requires a question.
 */
const REQUIRES_QUESTION = modelsForTask('describe-image').find(
  (model) => model.visionControls?.instructionRequired === true
)!;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * Mounts the Describe Image router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to a usable description.
 * @param identity Verified identity to present.
 * @returns The app, the fake inference port, and the captured logs.
 */
function mount(
  options: FakeInferenceOptions = {},
  identity: { email: string; sub: string } | undefined = IDENTITY
): {
  app: ReturnType<typeof mountRoute>['app'];
  inference: FakeInference;
  logs: LogCapture;
} {
  const inference = new FakeInference({
    output: () => ({ [CAPTIONS_ALONE.descriptionField ?? 'response']: 'A red door.' }),
    ...options
  });
  const { capture, logger } = createLogCapture();
  const service = new DescribeImageService({
    inference,
    runs: createMemoryRunRepository(),
    logger
  });

  const mounted = mountRoute('/api/describe-image', describeImageRouter, {
    identity,
    describeImageService: service,
    logger
  });
  mounted.app.onError(problemDetailsErrorHandler({ includeStack: false }));

  return { app: mounted.app, inference, logs: capture };
}

/**
 * Builds a request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A JSON-ready body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(120, 80),
    model: CAPTIONS_ALONE.id,
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
  return app.request('/api/describe-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('describing a picture', () => {
  it('returns the description, the verified facts, and a receipt', async () => {
    const { app } = mount();
    const response = await post(app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as DescribeImageResponse;
    expect(payload.description).toBe('A red door.');
    expect(payload.image).toMatchObject({ mediaType: 'image/png', width: 120, height: 80 });
    expect(payload.receipt.runId).toBe(RUN_ID);
  });

  it('reports the controls it applied, including the model default', async () => {
    const { app } = mount();
    const payload = (await (await post(app, body())).json()) as DescribeImageResponse;

    expect(payload.applied).toMatchObject({
      model: CAPTIONS_ALONE.id,
      maxTokens: CAPTIONS_ALONE.visionControls?.maxTokens?.default
    });
  });

  it('accepts a question and forwards it to the model', async () => {
    const { app, inference } = mount();
    await post(app, body({ instruction: 'What colour is the door?' }));

    const input = inference.requests[0]?.input as Record<string, unknown>;
    expect(input['prompt']).toBe('What colour is the door?');
  });
});

describe('rejected requests', () => {
  it('rejects a missing question for a model that requires one', async () => {
    const { app } = mount();
    const response = await post(app, body({ model: REQUIRES_QUESTION.id }));
    expect(response.status).toBe(400);
  });

  it('rejects a payload that is not a renderable image', async () => {
    const notAnImage = btoa('%PDF-1.7 this is not a picture');
    const response = await post(mount().app, body({ imageBase64: notAnImage }));
    expect(response.status).toBe(400);
  });

  it('rejects a body carrying an identity field', async () => {
    const response = await post(mount().app, body({ email: 'mallory@example.com' }));
    expect(response.status).toBe(400);
  });

  it('rejects a body describing its own image', async () => {
    const response = await post(mount().app, body({ mediaType: 'image/png' }));
    expect(response.status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await post(
      mount().app,
      body({ model: '@cf/black-forest-labs/flux-1-schnell' })
    );
    expect(response.status).toBe(400);
  });

  // The body limit is derived from the image budget rather than written separately, so the two
  // cannot drift into a state where a picture the panel accepts is refused by the transport.
  //
  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way. Matching the shared behaviour
  // matters more here than preferring a more specific status on this one route.
  it('refuses a body beyond the size limit', async () => {
    const { app } = mount();
    const response = await app.request('/api/describe-image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(DESCRIBE_IMAGE_BODY_LIMIT_BYTES + 1_024)
      },
      body: 'x'.repeat(DESCRIBE_IMAGE_BODY_LIMIT_BYTES + 1_024)
    });

    expect(response.status).toBe(400);
  });

  // Derived from the image budget rather than compared against a hard-coded size, so lowering
  // `MAX_INPUT_IMAGE_BYTES` — as the measured memory cost of the models' byte-array input format
  // required — cannot leave this assertion silently pinned to the old number.
  it('sizes the body limit to hold the largest accepted picture', () => {
    // Base64 inflates by about a third; a limit below that would reject a picture the domain
    // layer says is fine, which is the confusing failure this derivation prevents.
    expect(DESCRIBE_IMAGE_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_INPUT_IMAGE_BYTES * 1.34);
  });

  // Thrown as the real inference client throws it. The client logs the provider's own message and
  // raises a sanitised `502`, so a fake that threw a bare `Error` would exercise a path production
  // never takes and would assert a `500` that cannot happen.
  it('returns a sanitised 502 when the provider fails', async () => {
    const { app } = mount({
      failWith: new ProblemDetailsError({
        status: 502,
        title: 'The model could not complete this request',
        detail: 'The AI provider did not return a usable response.'
      })
    });
    const response = await post(app, body());

    expect(response.status).toBe(502);
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
  // Logged before the model is called. A request that fails inside the provider or is cancelled
  // mid-flight would otherwise leave no record of what was attempted, which is precisely the case
  // where the picture's size and format matter most.
  it('logs the attempt before calling the model', async () => {
    const { app, logs } = mount();
    await post(app, body({ instruction: 'What is this?' }));

    const started = logs.entries.find((entry) => entry.message === 'describe_image_run_started');
    expect(started).toBeDefined();
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: CAPTIONS_ALONE.id,
      mediaType: 'image/png',
      imageWidth: 120,
      imageHeight: 80,
      hasInstruction: true
    });
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'describe_image_run_started')).toBe(true);
    expect(logs.entries.some((entry) => entry.message === 'describe_image_run_failed')).toBe(true);
  });

  // Two requests that look identical in an access log have to be distinguishable in the structured
  // logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) => entry.message.startsWith('describe_image_run'));
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  it('records the picture\u2019s shape on failure, so the attempt is reproducible', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    const failed = logs.entries.find((entry) => entry.message === 'describe_image_run_failed');
    expect(failed?.context).toMatchObject({
      mediaType: 'image/png',
      imageWidth: 120,
      imageHeight: 80
    });
  });

  it('records the description length on success', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const completed = logs.entries.find(
      (entry) => entry.message === 'describe_image_run_completed'
    );
    expect(completed?.context?.['descriptionLength']).toBe('A red door.'.length);
  });

  // Written as "must not contain", because that is the direction that silently rots: a field
  // added later would pass a positive assertion while breaking this one.
  it('never logs the question, the description, or the verified email', async () => {
    const { app, logs } = mount({
      output: () => ({ [CAPTIONS_ALONE.descriptionField ?? 'response']: 'a confidential diagram' })
    });
    await post(app, body({ instruction: 'what does this secret whiteboard say' }));

    expect(logs.text()).not.toContain('secret whiteboard');
    expect(logs.text()).not.toContain('confidential diagram');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  // The picture itself is the largest piece of visitor content this demo handles, and base64 in a
  // log line would be both a privacy breach and unreadable.
  it('never logs the picture itself', async () => {
    const { app, logs } = mount();
    const payload = body();
    await post(app, payload);

    expect(logs.text()).not.toContain(payload['imageBase64'] as string);
  });
});

describe('identity', () => {
  // The attribution rule, asserted where it would actually be broken. A body field cannot reach
  // the gateway, because the domain refuses the body outright and the actor is assembled from the
  // verified claims alone.
  it('attributes the run to the verified identity rather than anything in the body', async () => {
    const { app, inference } = mount();
    await post(app, body());

    expect(inference.requests[0]?.actor).toEqual(IDENTITY);
  });
});
