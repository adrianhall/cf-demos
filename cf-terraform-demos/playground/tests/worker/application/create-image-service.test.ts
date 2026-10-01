import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../../src/images';
import { CreateImageService } from '../../../src/worker/application/create-image/create-image-service';
import { validateCreateImageRequest } from '../../../src/worker/domain/create-image';
import { encodeBase64 } from '../../../src/worker/domain/image-bytes';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  clearRunRecords,
  createMemoryRunRepository
} from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { problemWithStatus } from '../support/problem-details';

/**
 * A reviewed image model that exposes the full control set.
 */
const MODEL = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions !== undefined
)!;

/**
 * The reviewed image model that exposes only steps.
 */
const MINIMAL = modelsForTask('create-image').find(
  (model) => model.imageControls?.dimensions === undefined
)!;

/**
 * Run identifier used by the tests.
 */
const RUN_ID = '9f1b2c3d-4e5f-4061-8273-8495a6b7c8d9';

/**
 * The verified identity a run is attributed to.
 */
const ACTOR = { email: 'alice@example.com', sub: 'sub-alice' };

/**
 * A minimal valid PNG byte sequence.
 */
function pngBytes(length = 128): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

/**
 * Wraps bytes in a single-chunk `ReadableStream`, as one provider returns.
 *
 * @param bytes Payload to stream.
 * @param chunkSize Bytes per chunk, so a test can split a payload the way a network does.
 * @returns A fresh byte stream.
 */
function byteStream(bytes: Uint8Array, chunkSize?: number): ReadableStream<Uint8Array> {
  const size = chunkSize ?? bytes.length;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    }
  });
}

/**
 * Builds a validated request.
 *
 * @param overrides Body fields to replace.
 * @returns A validated request, so the service receives the type it requires.
 */
function request(overrides: Record<string, unknown> = {}) {
  return validateCreateImageRequest({
    prompt: 'a lighthouse',
    model: MODEL.id,
    runId: RUN_ID,
    ...overrides
  });
}

/**
 * Builds a service over a fake inference port.
 *
 * @param output Provider output the fake should return.
 * @param logId Gateway log identifier, or `null` for none.
 * @returns The service and the fake, so a test can assert on what reached the boundary.
 */
function serviceWith(output: () => unknown, logId?: string | null) {
  const inference = new FakeInference({
    output,
    ...(logId === undefined ? {} : { logId })
  });
  const runs = createMemoryRunRepository();
  return { service: new CreateImageService({ inference, runs }), inference, runs };
}

beforeEach(() => {
  clearRunRecords();
});

describe('CreateImageService.generate', () => {
  // The two reviewed models return their image in genuinely different shapes. Both have to produce
  // an identical result type, because that is what keeps the provider disagreement out of the route
  // and out of the browser.
  describe('normalises every provider output shape', () => {
    it('accepts a base64 JSON payload', async () => {
      const { service } = serviceWith(() => ({ image: encodeBase64(pngBytes()) }));
      const result = await service.generate(request({ model: MINIMAL.id }), ACTOR);

      expect(result.image.mediaType).toBe('image/png');
      expect(result.image.byteLength).toBe(128);
    });

    it('accepts a byte stream', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      const result = await service.generate(request(), ACTOR);

      expect(result.image.mediaType).toBe('image/png');
      expect(result.image.byteLength).toBe(128);
    });

    it('accepts a Uint8Array', async () => {
      const { service } = serviceWith(() => pngBytes());
      expect((await service.generate(request(), ACTOR)).image.mediaType).toBe('image/png');
    });

    it('accepts an ArrayBuffer', async () => {
      const { service } = serviceWith(() => pngBytes().buffer);
      expect((await service.generate(request(), ACTOR)).image.mediaType).toBe('image/png');
    });

    // A chunk boundary falls wherever the network puts it, so a streamed image has to be
    // reassembled before it is identified — a signature split across two chunks would otherwise
    // fail to match.
    it('reassembles a stream delivered in small chunks', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes(512), 3));
      const result = await service.generate(request(), ACTOR);

      expect(result.image.mediaType).toBe('image/png');
      expect(result.image.byteLength).toBe(512);
    });

    it('returns the image base64-encoded for JSON transport', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      const result = await service.generate(request(), ACTOR);

      expect(result.image.base64).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    });
  });

  describe('refuses output it cannot trust', () => {
    // The declared content type is never consulted, so a provider that answered with markup under
    // an image label is refused here rather than reaching a `data:` URI in the page.
    it('refuses SVG markup', async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      const { service } = serviceWith(() => byteStream(svg));

      await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(
        problemWithStatus(502)
      );
    });

    it('refuses a JSON error document returned under a success status', async () => {
      const json = new TextEncoder().encode('{"error":"content policy"}');
      const { service } = serviceWith(() => byteStream(json));

      await expect(service.generate(request(), ACTOR)).rejects.toThrow(/will not render/iu);
    });

    it('refuses an empty response', async () => {
      const { service } = serviceWith(() => byteStream(new Uint8Array(0)));
      await expect(service.generate(request(), ACTOR)).rejects.toThrow(/did not return an image/iu);
    });

    it('refuses an unrecognised output shape', async () => {
      const { service } = serviceWith(() => ({ unexpected: 'shape' }));
      await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(
        problemWithStatus(502)
      );
    });

    it('refuses a base64 field that is not valid base64', async () => {
      const { service } = serviceWith(() => ({ image: 'not base64 !!!' }));
      await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(
        problemWithStatus(502)
      );
    });

    it('refuses a text-generation response shape', async () => {
      const { service } = serviceWith(() => ({ response: 'I cannot draw that.' }));
      await expect(service.generate(request(), ACTOR)).rejects.toMatchObject(
        problemWithStatus(502)
      );
    });

    // Enforced during the read rather than after it, so a misbehaving upstream cannot exhaust the
    // isolate's memory before the check runs.
    it('refuses a stream larger than the relay cap', async () => {
      const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1_024);
      oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const { service } = serviceWith(() => byteStream(oversized, 64 * 1_024));

      await expect(service.generate(request(), ACTOR)).rejects.toThrow(/larger than/iu);
    });

    it('does not leak a provider message into the failure', async () => {
      const inference = new FakeInference({
        failWith: new Error('upstream: prompt "my secret" rejected by internal-host-7')
      });
      const service = new CreateImageService({
        inference,
        runs: createMemoryRunRepository()
      });

      const error = await service.generate(request(), ACTOR).catch((cause: unknown) => cause);
      const text = JSON.stringify(error);
      expect(text).not.toContain('my secret');
      expect(text).not.toContain('internal-host-7');
    });

    // A run that produced no usable image must leave no record. A record would let the browser poll
    // for the cost of something it was never given.
    it('records no run when the output could not be trusted', async () => {
      const { service, runs } = serviceWith(() => ({ unexpected: 'shape' }));
      await service.generate(request(), ACTOR).catch(() => undefined);

      expect(await runs.find(RUN_ID)).toBeUndefined();
    });
  });

  describe('attribution and gateway routing', () => {
    it('attributes the call to the verified actor', async () => {
      const { service, inference } = serviceWith(() => byteStream(pngBytes()));
      await service.generate(request(), ACTOR);

      expect(inference.requests[0]?.actor).toEqual(ACTOR);
    });

    it('sends the panel identifier and the reviewed descriptor', async () => {
      const { service, inference } = serviceWith(() => byteStream(pngBytes()));
      await service.generate(request(), ACTOR);

      expect(inference.requests[0]?.task).toBe('create-image');
      expect(inference.requests[0]?.model.id).toBe(MODEL.id);
    });

    it('reports the run as gateway-routed', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      expect((await service.generate(request(), ACTOR)).receipt.gatewayRouted).toBe(true);
    });

    it('forwards only the controls the model declares', async () => {
      const { service, inference } = serviceWith(() => ({ image: encodeBase64(pngBytes()) }));
      await service.generate(request({ model: MINIMAL.id, steps: 4 }), ACTOR);

      expect(Object.keys(inference.requests[0]?.input as object).sort()).toEqual([
        'prompt',
        'steps'
      ]);
    });

    it('produces different attribution for a second identity', async () => {
      const inference = new FakeInference({ output: () => byteStream(pngBytes()) });
      const service = new CreateImageService({
        inference,
        runs: createMemoryRunRepository()
      });

      await service.generate(request(), ACTOR);
      await service.generate(request({ runId: 'bbbbbbbb-1111-4222-8333-444455556666' }), {
        email: 'bob@example.com',
        sub: 'sub-bob'
      });

      expect(inference.requests.map((entry) => entry.actor.email)).toEqual([
        'alice@example.com',
        'bob@example.com'
      ]);
    });
  });

  describe('the run receipt', () => {
    it('reports a completed run carrying the gateway log', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()), 'log-img');
      const { receipt } = await service.generate(request(), ACTOR);

      expect(receipt.runId).toBe(RUN_ID);
      expect(receipt.task).toBe('create-image');
      expect(receipt.status).toBe('completed');
      expect(receipt.logIds).toEqual(['log-img']);
    });

    it('marks the cost pending when a gateway log exists', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()), 'log-1');
      expect((await service.generate(request(), ACTOR)).receipt.costStatus).toBe('pending');
    });

    it('marks the cost unavailable when the gateway assigned no log', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()), null);
      const { receipt } = await service.generate(request(), ACTOR);

      expect(receipt.costStatus).toBe('unavailable');
      expect(receipt.logIds).toEqual([]);
    });

    // Unlike Chat there is no streaming window, so the record exists by the time the caller holds
    // the receipt — there is no moment at which a metrics lookup could fail for a run that worked.
    it('records the run against the verified owner before returning', async () => {
      const { service, runs } = serviceWith(() => byteStream(pngBytes()));
      await service.generate(request(), ACTOR);

      const record = await runs.find(RUN_ID);
      expect(record?.ownerEmail).toBe('alice@example.com');
      expect(record?.task).toBe('create-image');
    });

    it('measures elapsed time from the injected clock', async () => {
      let clock = 5_000;
      const inference = new FakeInference({ output: () => byteStream(pngBytes()) });
      const service = new CreateImageService({
        inference,
        runs: createMemoryRunRepository(),
        now: () => {
          const reading = clock;
          clock += 850;
          return reading;
        }
      });

      expect((await service.generate(request(), ACTOR)).receipt.elapsedMs).toBe(850);
    });

    it('records an ISO 8601 start timestamp', async () => {
      const inference = new FakeInference({ output: () => byteStream(pngBytes()) });
      const service = new CreateImageService({
        inference,
        runs: createMemoryRunRepository(),
        now: () => Date.parse('2026-04-01T09:15:00.000Z')
      });

      expect((await service.generate(request(), ACTOR)).receipt.startedAt).toBe(
        '2026-04-01T09:15:00.000Z'
      );
    });
  });

  describe('the applied controls', () => {
    it('echoes the prompt and model that produced the image', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      const { applied } = await service.generate(request(), ACTOR);

      expect(applied.prompt).toBe('a lighthouse');
      expect(applied.model).toBe(MODEL.id);
    });

    it('fills in model defaults so the gallery can show what produced a result', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      const { applied } = await service.generate(request(), ACTOR);

      expect(applied.steps).toBe(MODEL.imageControls!.steps!.default);
    });

    it('reports a supplied control in preference to the default', async () => {
      const { service } = serviceWith(() => byteStream(pngBytes()));
      const { applied } = await service.generate(request({ steps: 12, seed: 7 }), ACTOR);

      expect(applied.steps).toBe(12);
      expect(applied.seed).toBe(7);
    });
  });

  it('propagates a provider failure as a sanitised 502', async () => {
    const inference = new FakeInference({ failWith: new Error('upstream down') });
    const service = new CreateImageService({ inference, runs: createMemoryRunRepository() });

    await expect(service.generate(request(), ACTOR)).rejects.toThrow();
  });
});
