import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useDescribeImage } from '../../../src/client/features/describe-image/useDescribeImage';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import type { DescribeImageRequest, DescribeImageResponse } from '../../../src/describe-image';

/**
 * A model that will caption a picture unasked.
 */
const CAPTIONS_ALONE: CatalogueModel = {
  id: '@cf/test/captions',
  name: 'Captioning Model',
  provider: 'workers-ai',
  task: 'describe-image',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/captions',
  visionControls: {
    instructionRequired: false,
    maxTokens: { min: 32, max: 1_024, step: 32, default: 512 }
  }
};

/**
 * A model that requires a question.
 */
const REQUIRES_QUESTION: CatalogueModel = {
  id: '@cf/test/asks',
  name: 'Questioning Model',
  provider: 'workers-ai',
  task: 'describe-image',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/asks',
  visionControls: {
    instructionRequired: true,
    maxTokens: { min: 32, max: 2_048, step: 32, default: 256 }
  }
};

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<DescribeImageResponse> = {}): DescribeImageResponse {
  return {
    description: 'A red door with a brass handle.',
    image: { mediaType: 'image/png', byteLength: 2_048, width: 120, height: 80 },
    receipt: {
      runId: 'run-1',
      task: 'describe-image',
      model: CAPTIONS_ALONE.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 120,
      startedAt: new Date().toISOString()
    },
    applied: { model: CAPTIONS_ALONE.id, maxTokens: 512 },
    ...overrides
  };
}

/**
 * Builds a `File` the composable will accept.
 *
 * @param type Declared media type.
 * @returns The file.
 */
function pictureFile(type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3, 4]) as BlobPart], 'picture.png', { type });
}

/**
 * Creates the composable with a stubbed transport.
 *
 * @param transport Transport to use; defaults to one resolving successfully.
 * @param models Catalogue models to offer.
 * @returns The composable result and the recorded requests.
 */
function create(
  transport?: (
    request: DescribeImageRequest,
    signal?: AbortSignal
  ) => Promise<DescribeImageResponse>,
  models: CatalogueModel[] = [CAPTIONS_ALONE, REQUIRES_QUESTION]
) {
  const requests: DescribeImageRequest[] = [];

  // Records every request before delegating, so a test can assert on what the panel *sent* as
  // well as how it handled the reply. Named `send` rather than `describe` because the latter
  // shadows Vitest's own `describe` inside this file.
  const send = async (
    request: DescribeImageRequest,
    signal?: AbortSignal
  ): Promise<DescribeImageResponse> => {
    requests.push(request);
    return transport === undefined ? response() : transport(request, signal);
  };

  const result = useDescribeImage({
    models: ref(models),
    describe: send,
    runOptions: { sleep: async () => {}, now: () => Date.now() }
  });

  return { ...result, requests };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' } as unknown as Crypto);
});

describe('selecting a picture', () => {
  it('accepts a valid file', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());

    expect(panel.image.value).toBeDefined();
    expect(panel.error.value).toBeNull();
  });

  it('reports a refusal rather than accepting the file', async () => {
    const panel = create();
    await panel.selectFile(pictureFile('image/gif'));

    expect(panel.image.value).toBeUndefined();
    expect(panel.error.value).toContain('PNG');
  });

  it('clears a previous error once a valid file is chosen', async () => {
    const panel = create();
    await panel.selectFile(pictureFile('image/gif'));
    await panel.selectFile(pictureFile());

    expect(panel.error.value).toBeNull();
  });

  // A description left on screen beside a different picture is worse than an empty space: it
  // reads as a description *of* the new picture.
  it('discards the previous answer when the picture changes', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.describe();
    expect(panel.description.value).toBeDefined();

    await panel.selectFile(pictureFile());
    expect(panel.description.value).toBeUndefined();
  });

  it('clears the picture and the answer on request', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.describe();

    panel.clearImage();
    expect(panel.image.value).toBeUndefined();
    expect(panel.description.value).toBeUndefined();
  });
});

describe('the model contract difference', () => {
  it('defaults to the first catalogue model', () => {
    expect(create().model.value).toBe(CAPTIONS_ALONE.id);
  });

  it('reports whether the selected model requires a question', async () => {
    const panel = create();
    expect(panel.instructionRequired.value).toBe(false);

    panel.model.value = REQUIRES_QUESTION.id;
    await Promise.resolve();
    expect(panel.instructionRequired.value).toBe(true);
  });

  // The contract difference, enforced before a request is made. The server still refuses it —
  // that is the authority — but a disabled button with a visible reason explains more than a
  // rejected request does.
  it('blocks submission when a required question is missing', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());

    panel.model.value = REQUIRES_QUESTION.id;
    await Promise.resolve();

    expect(panel.canDescribe.value).toBe(false);
  });

  it('allows submission with no question for a model that captions alone', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());

    expect(panel.canDescribe.value).toBe(true);
  });

  it('allows submission once the required question is supplied', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    panel.model.value = REQUIRES_QUESTION.id;
    await Promise.resolve();

    panel.instruction.value = 'What is this?';
    expect(panel.canDescribe.value).toBe(true);
  });

  it('treats a whitespace-only question as missing', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    panel.model.value = REQUIRES_QUESTION.id;
    await Promise.resolve();

    panel.instruction.value = '   ';
    expect(panel.canDescribe.value).toBe(false);
  });

  it('cannot be submitted without a picture', () => {
    const panel = create();
    panel.instruction.value = 'What is this?';
    expect(panel.canDescribe.value).toBe(false);
  });

  // Unlike a step count, the question is the visitor's own words. Discarding it when they compare
  // two models on the same question would be actively unhelpful.
  it('keeps the question when the model changes', async () => {
    const panel = create();
    panel.instruction.value = 'What colour is the door?';

    panel.model.value = REQUIRES_QUESTION.id;
    await Promise.resolve();

    expect(panel.instruction.value).toBe('What colour is the door?');
  });

  it('resets the answer-length cap when the model changes', async () => {
    const panel = create();
    panel.maxTokens.value = 128;

    panel.model.value = REQUIRES_QUESTION.id;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.maxTokens.value).toBeUndefined();
  });
});

describe('describing a picture', () => {
  it('sends the picture and returns the description', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.description.value).toBe('A red door with a brass handle.');
    expect(panel.requests[0]?.imageBase64).not.toBe('');
  });

  it('reports what the server verified about the picture', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.verified.value).toMatchObject({ width: 120, height: 80 });
  });

  it('trims the question before sending it', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    panel.instruction.value = '  What is this?  ';
    await panel.describe();

    expect(panel.requests[0]?.instruction).toBe('What is this?');
  });

  it('omits an empty question entirely', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(Object.hasOwn(panel.requests[0] ?? {}, 'instruction')).toBe(false);
  });

  // Keeps the panel from sending a control the server would refuse. The server is still the
  // authority; this stops a stale value producing a `400` that looks like a bug in the panel.
  it('omits a control the selected model does not declare', async () => {
    const withoutControls: CatalogueModel = {
      ...CAPTIONS_ALONE,
      visionControls: { instructionRequired: false }
    };
    const panel = create(undefined, [withoutControls]);

    await panel.selectFile(pictureFile());
    panel.maxTokens.value = 128;
    await panel.describe();

    expect(Object.hasOwn(panel.requests[0] ?? {}, 'maxTokens')).toBe(false);
  });

  it('does nothing when it cannot be submitted', async () => {
    const panel = create();
    await panel.describe();

    expect(panel.requests).toHaveLength(0);
  });

  it('shows the server\u2019s own message when the request is refused', async () => {
    const panel = create(async () => {
      throw new ApiError(400, 'Questioning Model requires a question about the picture.');
    });
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.error.value).toBe('Questioning Model requires a question about the picture.');
  });

  it('shows a generic message for a transport failure', async () => {
    const panel = create(async () => {
      throw new TypeError('network down');
    });
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.error.value).toContain('could not be described');
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message behind.
  it('leaves no error message when the visitor cancels', async () => {
    const panel = create(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.error.value).toBeNull();
  });

  it('clears the busy flag however the run ends', async () => {
    const panel = create(async () => {
      throw new TypeError('network down');
    });
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.describing.value).toBe(false);
  });

  it('produces no receipt for a failed run', async () => {
    const panel = create(async () => {
      throw new TypeError('network down');
    });
    await panel.selectFile(pictureFile());
    await panel.describe();

    expect(panel.receipt.value).toBeUndefined();
  });
});

describe('accepting a handoff', () => {
  // The picture arrives as bytes with no file, so its provenance stands in for a name.
  it('takes a picture generated in another panel', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image (Rich Model)'
    });

    expect(panel.image.value?.base64).toBe('AAAA');
    expect(panel.image.value?.fileName).toContain('Create Image');
  });

  it('builds a preview URI from the handed-over media type', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'AAAA',
      mediaType: 'image/webp',
      byteLength: 10,
      origin: 'Generated in Create Image'
    });

    expect(panel.image.value?.previewUri).toBe('data:image/webp;base64,AAAA');
  });

  it('can be described immediately', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 10,
      origin: 'Generated in Create Image'
    });

    expect(panel.canDescribe.value).toBe(true);
  });

  // Re-checked at the point of use even though the value came from the server's own sniff. This
  // is what hands a media type to the browser's `data:` URI parser, and that parser decides how
  // the payload is treated — so a future path staging a handoff from elsewhere cannot skip the
  // one guard that matters. The type system refuses this too; the runtime check is the backstop.
  it('refuses a handoff whose media type is not renderable', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'PHN2Zy8+',
      mediaType: 'image/svg+xml' as never,
      byteLength: 8,
      origin: 'Generated in Create Image'
    });

    expect(panel.image.value).toBeUndefined();
    expect(panel.error.value).toContain('not in a format this panel can display');
  });
});
