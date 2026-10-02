import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useClassifyImage } from '../../../src/client/features/classify-image/useClassifyImage';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import type {
  ClassifyImageRequest,
  ClassifyImageResponse
} from '../../../src/shared/classify-image';

/**
 * A classifier whose result controls this application applies, matching the reviewed model.
 */
const CLASSIFIER: CatalogueModel = {
  id: '@cf/test/classifier',
  name: 'Test Classifier',
  provider: 'workers-ai',
  task: 'classify-image',
  pricingUnit: 'provider-reported',
  documentationUrl: 'https://example.invalid/classifier',
  classificationControls: {
    topK: { min: 1, max: 10, step: 1, default: 5 },
    minimumConfidence: { min: 0, max: 1, step: 0.01, default: 0 },
    appliedBy: 'playground'
  }
};

/**
 * A second classifier with a narrower top-k range, so a model switch has something to reset.
 */
const NARROW: CatalogueModel = {
  id: '@cf/test/narrow',
  name: 'Narrow Classifier',
  provider: 'workers-ai',
  task: 'classify-image',
  pricingUnit: 'provider-reported',
  documentationUrl: 'https://example.invalid/narrow',
  classificationControls: {
    topK: { min: 1, max: 3, step: 1, default: 3 },
    appliedBy: 'model'
  }
};

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<ClassifyImageResponse> = {}): ClassifyImageResponse {
  return {
    labels: [
      { rank: 1, label: 'Egyptian cat', score: 0.52 },
      { rank: 2, label: 'tabby', score: 0.41 }
    ],
    totalLabels: 5,
    image: { mediaType: 'image/png', byteLength: 2_048, width: 120, height: 80 },
    receipt: {
      runId: 'run-1',
      task: 'classify-image',
      model: CLASSIFIER.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 120,
      startedAt: new Date().toISOString()
    },
    applied: { model: CLASSIFIER.id, topK: 5, minimumConfidence: 0 },
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
    request: ClassifyImageRequest,
    signal?: AbortSignal
  ) => Promise<ClassifyImageResponse>,
  models: CatalogueModel[] = [CLASSIFIER, NARROW]
) {
  const requests: ClassifyImageRequest[] = [];

  // Records every request before delegating, so a test can assert on what the panel *sent* as
  // well as how it handled the reply. Named `send` rather than `classify` because the latter
  // reads confusingly beside the composable's own action of that name.
  const send = async (
    request: ClassifyImageRequest,
    signal?: AbortSignal
  ): Promise<ClassifyImageResponse> => {
    requests.push(request);
    return transport === undefined ? response() : transport(request, signal);
  };

  const result = useClassifyImage({
    models: ref(models),
    classify: send,
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

  // A ranking left on screen beside a different picture is worse than an empty space: it reads as
  // a ranking *of* the new picture.
  it('discards the previous ranking when the picture changes', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.classify();
    expect(panel.labels.value).toBeDefined();

    await panel.selectFile(pictureFile());
    expect(panel.labels.value).toBeUndefined();
    expect(panel.totalLabels.value).toBeUndefined();
  });

  it('clears the picture and the ranking on request', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.classify();

    panel.clearImage();
    expect(panel.image.value).toBeUndefined();
    expect(panel.labels.value).toBeUndefined();
  });

  // The media type is re-checked at the point of use even though it came from the server's own
  // byte-level sniff, because this is what hands a type to the browser's `data:` URI parser.
  it('refuses a handoff whose media type the panel cannot display', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'AAAA',
      mediaType: 'image/gif' as never,
      byteLength: 4,
      origin: 'elsewhere'
    });

    expect(panel.image.value).toBeUndefined();
    expect(panel.error.value).toBeTruthy();
  });

  it('accepts a handoff from another panel', () => {
    const panel = create();
    panel.acceptHandoff({
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 4,
      origin: 'Generated in Create Image'
    });

    expect(panel.image.value?.previewUri).toBe('data:image/png;base64,AAAA');
    expect(panel.image.value?.fileName).toBe('Generated in Create Image');
  });
});

describe('the model selection', () => {
  it('defaults to the first catalogue model', () => {
    expect(create().model.value).toBe(CLASSIFIER.id);
  });

  // Each model declares its own ranges, so a value valid for one may be out of range for another.
  it('resets both controls when the model changes', async () => {
    const panel = create();
    panel.topK.value = 8;
    panel.minimumConfidence.value = 0.4;

    panel.model.value = NARROW.id;
    await Promise.resolve();

    expect(panel.topK.value).toBeUndefined();
    expect(panel.minimumConfidence.value).toBeUndefined();
  });
});

describe('running a classification', () => {
  // The only precondition is a picture: a classifier has no prompt to be missing.
  it('needs only a picture to be runnable', async () => {
    const panel = create();
    expect(panel.canClassify.value).toBe(false);

    await panel.selectFile(pictureFile());
    expect(panel.canClassify.value).toBe(true);
  });

  it('does nothing when no picture has been chosen', async () => {
    const panel = create();
    await panel.classify();

    expect(panel.requests).toHaveLength(0);
  });

  it('records the ranking, the total, and the receipt', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.labels.value?.map((entry) => entry.label)).toEqual(['Egyptian cat', 'tabby']);
    expect(panel.totalLabels.value).toBe(5);
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.topK).toBe(5);
  });

  it('sends only the controls the selected model declares', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    panel.topK.value = 3;
    panel.minimumConfidence.value = 0.2;
    await panel.classify();

    expect(panel.requests[0]).toMatchObject({ topK: 3, minimumConfidence: 0.2 });
  });

  // The second model has no confidence control at all, so sending one would be a request the
  // server refuses — a `400` the panel could have avoided.
  it('omits a control the selected model does not declare', async () => {
    const panel = create();
    panel.model.value = NARROW.id;
    await Promise.resolve();
    await panel.selectFile(pictureFile());
    panel.minimumConfidence.value = 0.5;
    await panel.classify();

    expect(panel.requests[0]).not.toHaveProperty('minimumConfidence');
  });

  it('omits an unset control so the model default applies', async () => {
    const panel = create();
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.requests[0]).not.toHaveProperty('topK');
    expect(panel.requests[0]).not.toHaveProperty('minimumConfidence');
  });

  // An empty ranking is a successful run, not an absence of one, and the panel has to be able to
  // tell the two apart in order to explain it.
  it('distinguishes an empty ranking from no run at all', async () => {
    const panel = create(async () => response({ labels: [], totalLabels: 5 }));
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.labels.value).toEqual([]);
    expect(panel.totalLabels.value).toBe(5);
  });
});

describe('failures', () => {
  // The server's message is written for a visitor, so it is shown in preference to a generic one.
  it('shows the server\u2019s own explanation', async () => {
    const panel = create(async () => {
      throw new ApiError(400, 'That control is out of range for this model.');
    });
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.error.value).toBe('That control is out of range for this model.');
  });

  it('falls back to a generic message for a transport failure', async () => {
    const panel = create(async () => {
      throw new TypeError('network down');
    });
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.error.value).toContain('could not be classified');
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
  it('stays silent when the visitor cancels', async () => {
    const panel = create(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.error.value).toBeNull();
  });

  it('stops reporting itself as busy after a failure', async () => {
    const panel = create(async () => {
      throw new Error('boom');
    });
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.classifying.value).toBe(false);
  });

  // A failed run has no receipt and must contribute nothing to the session meter.
  it('records no receipt for a failed run', async () => {
    const panel = create(async () => {
      throw new Error('boom');
    });
    await panel.selectFile(pictureFile());
    await panel.classify();

    expect(panel.receipt.value).toBeUndefined();
  });
});
