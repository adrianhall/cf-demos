import { beforeEach, describe, expect, it } from 'vitest';
import { problemDetailsErrorHandler } from '@adrianhall/cloudflare-toolkit/hono';
import type { CreateImageResponse } from '../../../src/images';
import { CreateImageService } from '../../../src/worker/application/create-image/create-image-service';
import { encodeBase64 } from '../../../src/worker/domain/image-bytes';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import {
  CREATE_IMAGE_BODY_LIMIT_BYTES,
  createImageRouter
} from '../../../src/worker/routes/create-image';
import { FakeInference, type FakeInferenceOptions } from '../support/fake-inference';
import { createLogCapture, mountRoute, type LogCapture } from '../support/mount';

/**
 * A reviewed image model exposing the full control set.
 */
const MODEL = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions !== undefined
)!;

/**
 * The reviewed image model exposing only steps.
 */
const MINIMAL = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions === undefined
)!;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/**
 * A minimal valid PNG byte sequence.
 *
 * @param length Total buffer length.
 * @returns PNG-signed bytes.
 */
function pngBytes(length = 128): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/**
 * Mounts the Create Image router with a fake inference port.
 *
 * @param options Inference behaviour to simulate; defaults to a valid base64 PNG.
 * @param identity Verified identity to present.
 * @returns The app, the fake inference port, and the captured logs.
 */
function mountCreateImage(
  options: FakeInferenceOptions = { output: () => ({ image: encodeBase64(pngBytes()) }) },
  identity: { email: string; sub: string } = { email: 'alice@example.com', sub: 'sub-alice' }
) {
  const inference = new FakeInference(options);
  // The route's own logger and the service's are the same recorder, mirroring the composition root
  // where both receive the request-scoped logger. A test that gave the service a separate one would
  // not notice if the composition root stopped wiring it.
  const { capture, logger } = createLogCapture();
  const createImageService = new CreateImageService({
    inference,
    runs: createMemoryRunRepository(),
    logger
  });
  const { app } = mountRoute('/api/create-image', createImageRouter, {
    identity,
    createImageService,
    logger
  });
  const logs = capture;
  app.onError(problemDetailsErrorHandler({ includeStack: false }));
  return { app, inference, logs };
}

/**
 * Posts a Create Image request.
 *
 * @param app The mounted app.
 * @param payload Request body to send.
 * @returns The response.
 */
async function post(
  app: ReturnType<typeof mountCreateImage>['app'],
  payload: Record<string, unknown>
): Promise<Response> {
  return app.request('/api/create-image', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * A valid request body with selected fields overridden.
 *
 * @param overrides Fields to replace or add.
 * @returns A request body.
 */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { prompt: 'a lighthouse', model: MODEL.id, runId: RUN_ID, ...overrides };
}

beforeEach(() => {
  clearRunRecords();
});

describe('POST /api/create-image', () => {
  it('returns the generated image with its receipt', async () => {
    const { app } = mountCreateImage();
    const response = await post(app, body());

    expect(response.status).toBe(200);
    const result = (await response.json()) as CreateImageResponse;
    expect(result.image.mediaType).toBe('image/png');
    expect(result.receipt.runId).toBe(RUN_ID);
    expect(result.receipt.task).toBe('create-image');
  });

  // JSON rather than SSE: there is nothing to stream, because a diffusion model produces its image
  // at the end of its run.
  it('answers with JSON rather than an event stream', async () => {
    const { app } = mountCreateImage();
    const response = await post(app, body());

    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('returns the applied controls so the gallery can describe the result', async () => {
    const { app } = mountCreateImage();
    const result = (await (await post(app, body({ steps: 12 }))).json()) as CreateImageResponse;

    expect(result.applied.prompt).toBe('a lighthouse');
    expect(result.applied.steps).toBe(12);
  });

  it('attributes the gateway metadata to the verified identity', async () => {
    const { app, inference } = mountCreateImage();
    await post(app, body());

    expect(inference.requests[0]?.actor.email).toBe('alice@example.com');
  });

  it('attributes a second identity\u2019s identical prompt to that identity', async () => {
    const { app, inference } = mountCreateImage(
      { output: () => ({ image: encodeBase64(pngBytes()) }) },
      { email: 'bob@example.com', sub: 'sub-bob' }
    );
    await post(app, body());

    expect(inference.requests[0]?.actor.email).toBe('bob@example.com');
  });

  describe('validation', () => {
    it.each([
      ['a missing prompt', { model: MODEL.id, runId: RUN_ID }],
      ['an empty prompt', { prompt: '  ', model: MODEL.id, runId: RUN_ID }],
      ['an unknown model', { prompt: 'x', model: 'made-up', runId: RUN_ID }],
      ['a malformed run identifier', { prompt: 'x', model: MODEL.id, runId: '!!' }]
    ])('rejects %s with problem details', async (_label, payload) => {
      const { app } = mountCreateImage();
      const response = await post(app, payload as Record<string, unknown>);

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // The rule this phase exists to demonstrate, enforced at the HTTP boundary.
    it('rejects a control the selected model does not support', async () => {
      const { app, inference } = mountCreateImage();
      const response = await post(app, body({ model: MINIMAL.id, negativePrompt: 'people' }));

      expect(response.status).toBe(400);
      // Refused before dispatch, so no invalid request reached a provider.
      expect(inference.requests).toEqual([]);
    });

    it('names the model in an unsupported-control refusal', async () => {
      const { app } = mountCreateImage();
      const response = await post(app, body({ model: MINIMAL.id, seed: 1 }));
      const problem = (await response.json()) as { detail: string };

      expect(problem.detail).toContain(MINIMAL.name);
    });

    it('rejects a step count outside the selected model\u2019s range', async () => {
      const { app } = mountCreateImage();
      const tooMany = MINIMAL.imageControls!.steps!.max + 1;
      const response = await post(app, body({ model: MINIMAL.id, steps: tooMany }));

      expect(response.status).toBe(400);
    });

    it.each(['user', 'email', 'actor', 'sub'])(
      'refuses a spoofed "%s" body field',
      async (field) => {
        const { app, inference } = mountCreateImage();
        const response = await post(app, body({ [field]: 'attacker@example.com' }));

        expect(response.status).toBe(400);
        expect(inference.requests).toEqual([]);
      }
    );

    it('rejects a malformed JSON body', async () => {
      const { app } = mountCreateImage();
      const response = await app.request('/api/create-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json'
      });

      expect(response.status).toBe(400);
    });

    it('rejects a body over the size limit', async () => {
      const { app } = mountCreateImage();
      const response = await app.request('/api/create-image', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(CREATE_IMAGE_BODY_LIMIT_BYTES + 1_024)
        },
        body: 'x'.repeat(CREATE_IMAGE_BODY_LIMIT_BYTES + 1_024)
      });

      expect(response.status).toBe(400);
    });
  });

  describe('untrustworthy provider output', () => {
    // Never reaches the browser as an image. A `data:` URI's media type decides how the payload is
    // treated, so markup must be refused at the boundary rather than labelled a picture.
    it('refuses SVG markup with a 502', async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const { app } = mountCreateImage({ output: () => ({ image: encodeBase64(svg) }) });
      const response = await post(app, body());

      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('refuses a provider error document returned under a success status', async () => {
      const json = new TextEncoder().encode('{"error":"content policy"}');
      const { app } = mountCreateImage({ output: () => ({ image: encodeBase64(json) }) });

      expect((await post(app, body())).status).toBe(502);
    });

    it('does not leak a provider message into the failure response', async () => {
      const { app } = mountCreateImage({
        failWith: new Error('upstream: prompt "my secret" rejected by internal-host-7')
      });
      const text = await (await post(app, body())).text();

      expect(text).not.toContain('my secret');
      expect(text).not.toContain('internal-host-7');
    });

    it('leaks no stack trace from a provider failure', async () => {
      const { app } = mountCreateImage({ failWith: new Error('boom') });
      const text = await (await post(app, body())).text();

      expect(text).not.toMatch(/\n\s*at\s/u);
      expect(text).not.toContain('.ts:');
    });
  });

  describe('structured logging', () => {
    /**
     * Asserts that nothing sensitive reached the Worker's structured logs.
     *
     * @param logs The captured logs.
     * @returns Nothing; fails the test when a forbidden value is present.
     */
    function expectNoSensitiveData(logs: LogCapture): void {
      const text = logs.text();
      // The prompt is the visitor's content and the email belongs in AI Gateway metadata only: a
      // structured log is a different retention domain with different access control.
      expect(text).not.toContain('a lighthouse');
      expect(text).not.toContain('alice@example.com');
    }

    it('records a completed run without the prompt, image, or email', async () => {
      const { app, logs } = mountCreateImage();
      await post(app, body());

      expect(logs.entries.some((entry) => entry.message === 'create_image_run_completed')).toBe(
        true
      );
      expectNoSensitiveData(logs);
    });

    // The base64 payload is large and is the visitor's generated content. Its length and type are
    // genuinely useful when diagnosing a provider that changed shape; its bytes are not.
    it('records the image size and type but never the image itself', async () => {
      const { app, logs } = mountCreateImage();
      await post(app, body());

      const completed = logs.entries.find(
        (entry) => entry.message === 'create_image_run_completed'
      );
      expect(completed?.context).toMatchObject({ mediaType: 'image/png', byteLength: 128 });
      expect(logs.text()).not.toContain(encodeBase64(pngBytes()));
    });

    it('records a failure without the prompt or email', async () => {
      const { app, logs } = mountCreateImage({ failWith: new Error('boom') });
      await post(app, body());

      expect(logs.entries.some((entry) => entry.message === 'create_image_run_failed')).toBe(true);
      expectNoSensitiveData(logs);
    });

    it('records the run identifier and model, which are safe to retain', async () => {
      const { app, logs } = mountCreateImage();
      await post(app, body());

      const completed = logs.entries.find(
        (entry) => entry.message === 'create_image_run_completed'
      );
      expect(completed?.context).toMatchObject({ runId: RUN_ID, model: MODEL.id });
    });
  });
});

describe('POST /api/create-image diagnostics', () => {
  // The question the logs could not answer: with two visually identical POSTs in an access log,
  // which one was this? A start line carrying the run identifier and the settings answers it, and
  // it is written before the model is called so it survives a failure, a timeout, or a cancellation.
  it('logs the attempt before calling the model', async () => {
    const { app, logs } = mountCreateImage({ failWith: new Error('boom') });
    await post(app, body({ steps: 20, guidance: 7.5 }));

    const started = logs.entries.find((entry) => entry.message === 'create_image_run_started');
    expect(started).toBeDefined();
    expect(started?.context).toMatchObject({ runId: RUN_ID, model: MODEL.id });
  });

  it('logs the requested controls and their values', async () => {
    const { app, logs } = mountCreateImage();
    await post(app, body({ steps: 20, guidance: 7.5, width: 512, height: 512, seed: 42 }));

    const started = logs.entries.find((entry) => entry.message === 'create_image_run_started');
    expect(started?.context?.['requested']).toMatchObject({
      steps: 20,
      guidance: 7.5,
      width: 512,
      height: 512,
      seed: 42
    });
  });

  // Naming only the controls that were supplied makes the line read as the visitor's decisions
  // rather than a fixed set of fields padded with nulls.
  it('names only the controls that were supplied', async () => {
    const { app, logs } = mountCreateImage();
    await post(app, body({ steps: 12 }));

    const started = logs.entries.find((entry) => entry.message === 'create_image_run_started');
    expect(started?.context?.['requestedControls']).toEqual(['steps']);
  });

  it('records whether a negative prompt was used without logging it', async () => {
    const { app, logs } = mountCreateImage();
    await post(app, body({ negativePrompt: 'people, cars' }));

    const started = logs.entries.find((entry) => entry.message === 'create_image_run_started');
    expect(started?.context?.['hasNegativePrompt']).toBe(true);
    expect(started?.context?.['negativePromptLength']).toBe(12);
    expect(logs.text()).not.toContain('people, cars');
  });

  it('records the prompt length but never the prompt text', async () => {
    const { app, logs } = mountCreateImage();
    await post(app, body({ prompt: 'a lighthouse' }));

    const started = logs.entries.find((entry) => entry.message === 'create_image_run_started');
    expect(started?.context?.['promptLength']).toBe(12);
    expect(logs.text()).not.toContain('a lighthouse');
  });

  // Both halves of the story under one run identifier: the panel-level outcome and, from the
  // inference client, the provider's own message.
  it('repeats the settings on the failure line', async () => {
    const { app, logs } = mountCreateImage({ failWith: new Error('boom') });
    await post(app, body({ steps: 20 }));

    const failed = logs.entries.find((entry) => entry.message === 'create_image_run_failed');
    expect(failed?.context).toMatchObject({ runId: RUN_ID });
    expect(failed?.context?.['requested']).toMatchObject({ steps: 20 });
  });

  it('never logs the verified email on any line', async () => {
    const { app, logs } = mountCreateImage({ failWith: new Error('boom') });
    await post(app, body({ steps: 20 }));

    expect(logs.text()).not.toContain('alice@example.com');
  });

  // A refusal by our own validation looks identical to a provider error from the browser — both are
  // a 502 — so the two must be distinguishable in the logs. They have different fixes.
  it('logs an unusable provider output as a rejection, not a provider error', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    const { app, logs } = mountCreateImage({ output: () => ({ image: encodeBase64(gif) }) });
    await post(app, body());

    const rejected = logs.entries.find((entry) => entry.message === 'create_image_output_unusable');
    expect(rejected?.context?.['reason']).toBe('unrenderable_format');
  });

  // The leading bytes in hex reveal whether the payload was a GIF, a JSON error document, or HTML,
  // without putting the payload itself in a log.
  it('logs the leading bytes of an unrenderable payload', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    const { app, logs } = mountCreateImage({ output: () => ({ image: encodeBase64(gif) }) });
    await post(app, body());

    const rejected = logs.entries.find((entry) => entry.message === 'create_image_output_unusable');
    expect(String(rejected?.context?.['signature'])).toContain('47 49 46 38');
  });

  it('logs the keys of an unrecognised output envelope', async () => {
    const { app, logs } = mountCreateImage({ output: () => ({ unexpected: 'shape', code: 7 }) });
    await post(app, body());

    const rejected = logs.entries.find((entry) => entry.message === 'create_image_output_unusable');
    expect(rejected?.context?.['outputKeys']).toEqual(['unexpected', 'code']);
  });
});
