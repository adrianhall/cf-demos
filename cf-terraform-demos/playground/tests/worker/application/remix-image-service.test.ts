import { describe, expect, it, vi } from 'vitest';
import type { GeneratedMediaPort } from '../../../src/worker/application/ports/generated-media-port';
import { RemixImageService } from '../../../src/worker/application/remix-image/remix-image-service';
import { modelsForTask } from '../../../src/worker/domain/models';
import { validateRemixImageRequest } from '../../../src/worker/domain/remix-image';
import { createMemoryRunRepository } from '../../../src/worker/infrastructure/runs/memory-run-repository';
import { FakeInference } from '../support/fake-inference';
import { pngBase64 } from '../support/image-fixtures';

const MODEL = modelsForTask('remix-image').find((model) => model.id === 'pruna/p-image-edit')!;
const ACTOR = { email: 'verified@example.com', sub: 'subject-1' };
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const RESULT_URL = 'https://delivery.bfl.ai/results/run/sample.png?token=signed';

/**
 * Builds a validated request.
 */
function request() {
  return validateRemixImageRequest({
    imageBase64: pngBase64(),
    instruction: 'Preserve the subject and restyle it as watercolor.',
    model: MODEL.id,
    runId: RUN_ID
  });
}

describe('RemixImageService', () => {
  it('routes FLUX editing through inference then retrieves its generated URL', async () => {
    const inference = new FakeInference({
      logId: 'gateway-log-1',
      output: () => ({ image: RESULT_URL })
    });
    const media: GeneratedMediaPort = {
      fetchImage: vi.fn(() =>
        Promise.resolve({ base64: pngBase64(), mediaType: 'image/png' as const, byteLength: 24 })
      )
    };
    let now = 1_000;
    const service = new RemixImageService({
      inference,
      media,
      runs: createMemoryRunRepository(() => now),
      now: () => (now += 50)
    });

    const result = await service.remix(request(), ACTOR);
    expect(inference.requests[0]).toMatchObject({ task: 'remix-image', actor: ACTOR });
    expect(media.fetchImage).toHaveBeenCalledWith(RESULT_URL, []);
    expect(result.image.mediaType).toBe('image/png');
    expect(result.receipt).toMatchObject({ runId: RUN_ID, costStatus: 'pending' });
  });

  it('marks the direct FLUX multipart exception as not gateway-routed and uncosted', async () => {
    const flux = modelsForTask('remix-image')[0]!;
    const fluxRequest = validateRemixImageRequest({
      imageBase64: pngBase64(),
      instruction: 'Preserve the source while restyling it.',
      model: flux.id,
      runId: 'flux-run-123'
    });
    const inference = new FakeInference({
      logId: null,
      output: () => ({ image: pngBase64() })
    });
    const media: GeneratedMediaPort = {
      fetchImage: vi.fn(() =>
        Promise.resolve({ base64: pngBase64(), mediaType: 'image/png' as const, byteLength: 24 })
      )
    };
    const service = new RemixImageService({
      inference,
      media,
      runs: createMemoryRunRepository()
    });

    const result = await service.remix(fluxRequest, ACTOR);
    expect(result.receipt).toMatchObject({
      gatewayRouted: false,
      logIds: [],
      costStatus: 'not-applicable'
    });
  });

  it('refuses a response without the reviewed image URL field', async () => {
    const inference = new FakeInference({ output: () => ({ state: 'Completed' }) });
    const media: GeneratedMediaPort = { fetchImage: vi.fn() };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const service = new RemixImageService({
      inference,
      media,
      runs: createMemoryRunRepository(),
      logger
    });

    await expect(service.remix(request(), ACTOR)).rejects.toMatchObject({
      problemDetails: { status: 502 }
    });
    expect(media.fetchImage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'remix_image_output_unusable',
      expect.objectContaining({ reason: 'missing_or_invalid_image', runId: RUN_ID })
    );
  });
});
