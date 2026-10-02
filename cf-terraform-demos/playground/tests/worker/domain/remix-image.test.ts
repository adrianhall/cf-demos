import { describe, expect, it } from 'vitest';
import { modelsForTask } from '../../../src/worker/domain/models';
import {
  buildRemixImageInput,
  describeAppliedRemixControls,
  validateRemixImageRequest
} from '../../../src/worker/domain/remix-image';
import { pngBase64, pngBytes, toBase64 } from '../support/image-fixtures';
import { thrownBy } from '../support/problem-details';

const MODELS = modelsForTask('remix-image');
const FLUX = MODELS.find((model) => model.id === '@cf/black-forest-labs/flux-2-klein-4b')!;
const PRUNA = MODELS.find((model) => model.id === 'pruna/p-image-edit')!;
const NANO = MODELS.find((model) => model.id === 'google/nano-banana-2')!;
const RUN_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Builds a valid reference-image edit request.
 */
function body(model = FLUX, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    imageBase64: pngBase64(),
    instruction: ' Restyle this while preserving the major subject. ',
    model: model.id,
    runId: RUN_ID,
    ...overrides
  };
}

describe('Remix Image descriptors', () => {
  it('uses Cloudflare-hosted FLUX.2 Klein 4B as the default', () => {
    expect(MODELS[0]).toBe(FLUX);
    expect(FLUX.provider).toBe('workers-ai');
    expect(FLUX.remixImageControls).toMatchObject({
      inputAdapter: 'flux-multipart',
      maxInputEdge: 512,
      seed: false
    });
  });

  it('reviews all three Cloudflare-hosted FLUX.2 editors plus third-party comparisons', () => {
    expect(
      MODELS.filter((model) => model.remixImageControls?.inputAdapter === 'flux-multipart').map(
        (model) => model.id
      )
    ).toEqual([
      '@cf/black-forest-labs/flux-2-klein-4b',
      '@cf/black-forest-labs/flux-2-klein-9b',
      '@cf/black-forest-labs/flux-2-dev'
    ]);
    expect(PRUNA.remixImageControls?.inputAdapter).toBe('pruna-json');
    expect(NANO.remixImageControls?.inputAdapter).toBe('nano-banana-json');
    expect(PRUNA.provider).toBe('third-party');
    expect(NANO.provider).toBe('third-party');
  });
});

describe('validateRemixImageRequest', () => {
  it('verifies source bytes and trims its instruction', () => {
    const request = validateRemixImageRequest(body());
    expect(request.instruction).toBe('Restyle this while preserving the major subject.');
    expect(request.source.facts).toMatchObject({ mediaType: 'image/png', width: 64, height: 64 });
  });

  it('rejects absent/unrecognised source, missing instruction, and spoofed identity', () => {
    expect(
      thrownBy(() => validateRemixImageRequest(body(FLUX, { imageBase64: undefined })))
    ).toMatchObject({ problemDetails: { status: 400 } });
    expect(
      thrownBy(() =>
        validateRemixImageRequest(body(FLUX, { imageBase64: toBase64(new Uint8Array([1, 2, 3])) }))
      )
    ).toMatchObject({ problemDetails: { status: 400 } });
    expect(
      thrownBy(() => validateRemixImageRequest(body(FLUX, { instruction: ' ' })))
    ).toMatchObject({ problemDetails: { status: 400 } });
    expect(
      thrownBy(() => validateRemixImageRequest(body(FLUX, { email: 'spoof@example.com' })))
    ).toMatchObject({ problemDetails: { status: 400 } });
  });

  it('rejects retired inpainting controls', () => {
    for (const field of ['maskBase64', 'strength']) {
      expect(thrownBy(() => validateRemixImageRequest(body(FLUX, { [field]: 1 })))).toMatchObject({
        problemDetails: { status: 400, detail: expect.stringContaining('reference-image editing') }
      });
    }
  });

  it('enforces FLUX reference image dimensions', () => {
    expect(
      thrownBy(() =>
        validateRemixImageRequest(body(FLUX, { imageBase64: toBase64(pngBytes(513, 512)) }))
      )
    ).toMatchObject({
      problemDetails: { status: 400, detail: expect.stringContaining('512×512') }
    });
  });

  it('accepts seed only for P-Image-Edit', () => {
    expect(validateRemixImageRequest(body(PRUNA, { seed: 8 })).seed).toBe(8);
    expect(thrownBy(() => validateRemixImageRequest(body(FLUX, { seed: 8 })))).toMatchObject({
      problemDetails: { status: 400 }
    });
    expect(thrownBy(() => validateRemixImageRequest(body(NANO, { seed: 8 })))).toMatchObject({
      problemDetails: { status: 400 }
    });
  });
});

describe('provider input mapping', () => {
  it('builds FLUX multipart with the verified source', async () => {
    const input = buildRemixImageInput(validateRemixImageRequest(body()));
    const multipart = input['multipart'] as { body: ReadableStream; contentType: string };
    expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=/u);
    const decoded = await new Response(multipart.body, {
      headers: { 'content-type': multipart.contentType }
    }).formData();
    expect(decoded.get('prompt')).toBe('Restyle this while preserving the major subject.');
    expect(decoded.get('input_image_0')).toBeInstanceOf(File);
  });

  it('builds P-Image-Edit JSON with required safe defaults', () => {
    const request = validateRemixImageRequest(body(PRUNA, { seed: 8 }));
    expect(buildRemixImageInput(request)).toEqual({
      prompt: request.instruction,
      images: [`data:image/png;base64,${pngBase64()}`],
      turbo: true,
      aspect_ratio: 'match_input_image',
      disable_safety_checker: false,
      seed: 8
    });
    expect(describeAppliedRemixControls(request).seed).toBe(8);
  });

  it('builds Nano Banana JSON with source-matching output', () => {
    const request = validateRemixImageRequest(body(NANO));
    expect(buildRemixImageInput(request)).toEqual({
      prompt: request.instruction,
      image_input: [`data:image/png;base64,${pngBase64()}`],
      aspect_ratio: 'match_input_image',
      output_format: 'png',
      resolution: '1K'
    });
  });
});
