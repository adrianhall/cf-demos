import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import { ProblemDetailsError } from '@adrianhall/cloudflare-toolkit/problem-details';
import type { ClassifyImageResponse } from '../../../src/shared/classify-image';
import { MAX_INPUT_IMAGE_BYTES } from '../../../src/shared/describe-image';
import { ClassifyImageService } from '../../../src/worker/application/classify-image/classify-image-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  CLASSIFY_IMAGE_BODY_LIMIT_BYTES,
  classifyImageRouter
} from '../../../src/worker/routes/classify-image';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * The reviewed classifier.
 */
const RESNET = modelsForTask('classify-image')[0]!;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * The verified identity the route attributes runs to.
 */
const IDENTITY = { email: 'alice@example.com', sub: 'alice-sub' };

/**
 * A plausible classifier response.
 */
const SCORED = [
  { label: 'tabby', score: 0.4 },
  { label: 'Egyptian cat', score: 0.52 },
  { label: 'lynx', score: 0.03 }
];

/**
 * Mounts the Classify Image router with a fake inference port.
 *
 * The logger is shared between the route and the service, exactly as the composition root wires
 * them, so a test can assert on the whole story of one request rather than half of it.
 *
 * @param options Inference behaviour to simulate; defaults to a usable ranking.
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
  const inference = new FakeInference({ output: () => SCORED, ...options });
  const { capture, logger } = createLogCapture();
  const service = new ClassifyImageService({
    inference,
    runs: createMemoryRunRepository(),
    logger
  });

  const mounted = mountRoute('/api/classify-image', classifyImageRouter, {
    identity,
    classifyImageService: service,
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
    model: RESNET.id,
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
  return app.request('/api/classify-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

beforeEach(() => {
  clearRunRecords();
});

describe('classifying a picture', () => {
  it('returns the ranked labels, the verified facts, and a receipt', async () => {
    const response = await post(mount().app, body());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ClassifyImageResponse;
    expect(payload.labels[0]).toMatchObject({ rank: 1, label: 'Egyptian cat' });
    expect(payload.image).toMatchObject({ mediaType: 'image/png', width: 120, height: 80 });
    expect(payload.receipt.runId).toBe(RUN_ID);
  });

  // The count the panel needs in order to say how much of the model's answer is on screen.
  it('reports how many labels the model returned alongside how many survived', async () => {
    const payload = (await (
      await post(mount().app, body({ topK: 1 }))
    ).json()) as ClassifyImageResponse;

    expect(payload.labels).toHaveLength(1);
    expect(payload.totalLabels).toBe(3);
  });

  it('reports the controls it applied, including the model defaults', async () => {
    const payload = (await (await post(mount().app, body())).json()) as ClassifyImageResponse;

    expect(payload.applied).toMatchObject({
      model: RESNET.id,
      topK: RESNET.classificationControls?.topK?.default
    });
  });

  // Applied to the response rather than sent, because the schema declares `image` and nothing
  // else. Asserted at the route because this is the boundary a new control would be added at.
  it('never forwards a result control to the model', async () => {
    const { app, inference } = mount();
    await post(app, body({ topK: 2, minimumConfidence: 0.3 }));

    expect(Object.keys(inference.requests[0]?.input as Record<string, unknown>)).toEqual(['image']);
  });
});

describe('rejected requests', () => {
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

  // A classifier has nothing to be asked, and saying so is more useful than ignoring the field.
  it('rejects an instruction, since a classifier takes none', async () => {
    const response = await post(mount().app, body({ instruction: 'what is this?' }));
    expect(response.status).toBe(400);
  });

  it('rejects a control outside the model\u2019s declared range', async () => {
    expect((await post(mount().app, body({ topK: 99 }))).status).toBe(400);
    expect((await post(mount().app, body({ minimumConfidence: 2 }))).status).toBe(400);
  });

  it('rejects a model belonging to another panel', async () => {
    const response = await post(mount().app, body({ model: '@cf/microsoft/not-a-model' }));
    expect(response.status).toBe(400);
  });

  // A `400` rather than a `413`: the shared `jsonBodyLimit` reports an oversized body as a bad
  // request, and every panel in this demo answers the same way.
  it('refuses a body beyond the size limit', async () => {
    const { app } = mount();
    const response = await app.request('/api/classify-image', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(CLASSIFY_IMAGE_BODY_LIMIT_BYTES + 1_024)
      },
      body: 'x'.repeat(CLASSIFY_IMAGE_BODY_LIMIT_BYTES + 1_024)
    });

    expect(response.status).toBe(400);
  });

  // Derived from the image budget rather than compared against a hard-coded size, so changing
  // `MAX_INPUT_IMAGE_BYTES` cannot leave this assertion pinned to the old number.
  it('sizes the body limit to hold the largest accepted picture', () => {
    expect(CLASSIFY_IMAGE_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_INPUT_IMAGE_BYTES * 1.34);
  });

  // Thrown as the real inference client throws it. The client logs the provider's own message and
  // raises a sanitised `502`, so a fake that threw a bare `Error` would exercise a path production
  // never takes.
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
    await post(app, body({ topK: 3 }));

    const started = logs.entries.find((entry) => entry.message === 'classify_image_run_started');
    expect(started?.context).toMatchObject({
      runId: RUN_ID,
      model: RESNET.id,
      mediaType: 'image/png',
      imageWidth: 120,
      imageHeight: 80,
      topK: 3
    });
  });

  // Which control was set is the diagnostic. A request with a high floor and one with a low top-k
  // produce a short result for entirely different reasons.
  it('names the controls the caller set', async () => {
    const { app, logs } = mount();
    await post(app, body({ minimumConfidence: 0.4 }));

    const started = logs.entries.find((entry) => entry.message === 'classify_image_run_started');
    expect(started?.context?.['requestedControls']).toEqual(['minimumConfidence']);
  });

  it('logs the attempt even when the provider then fails', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    expect(logs.entries.some((entry) => entry.message === 'classify_image_run_started')).toBe(true);
    expect(logs.entries.some((entry) => entry.message === 'classify_image_run_failed')).toBe(true);
  });

  // Two requests that look identical in an access log have to be distinguishable in the structured
  // logs, which is what the run identifier on every line provides.
  it('correlates every line of one request by run identifier', async () => {
    const { app, logs } = mount();
    await post(app, body());

    const runLines = logs.entries.filter((entry) => entry.message.startsWith('classify_image_run'));
    expect(runLines.length).toBeGreaterThanOrEqual(2);
    for (const line of runLines) {
      expect(line.context?.['runId'], `${line.message} carries a run identifier`).toBe(RUN_ID);
    }
  });

  it('records the picture\u2019s shape on failure, so the attempt is reproducible', async () => {
    const { app, logs } = mount({ failWith: new Error('upstream failure') });
    await post(app, body());

    const failed = logs.entries.find((entry) => entry.message === 'classify_image_run_failed');
    expect(failed?.context).toMatchObject({
      mediaType: 'image/png',
      imageWidth: 120,
      imageHeight: 80
    });
  });

  // How many the model returned against how many survived is what explains a short result list
  // without having to log any of the labels themselves.
  it('records the returned and shown label counts on success', async () => {
    const { app, logs } = mount();
    await post(app, body({ topK: 2 }));

    const completed = logs.entries.find(
      (entry) => entry.message === 'classify_image_run_completed'
    );
    expect(completed?.context).toMatchObject({ returnedLabels: 3, shownLabels: 2 });
  });

  // Written as "must not contain", because that is the direction that silently rots: a field
  // added later would pass a positive assertion while breaking this one.
  it('never logs a label or the verified email', async () => {
    const { app, logs } = mount({
      output: () => [{ label: 'a confidential whiteboard', score: 0.9 }]
    });
    await post(app, body());

    expect(logs.text()).not.toContain('confidential whiteboard');
    expect(logs.text()).not.toContain(IDENTITY.email);
  });

  // The picture is the largest piece of visitor content this panel handles, and base64 in a log
  // line would be both a privacy breach and unreadable.
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
