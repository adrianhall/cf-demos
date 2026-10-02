import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useCreateImage } from '../../../src/client/features/create-image/useCreateImage';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useLedgerStore } from '../../../src/client/stores/ledger';
import { MAX_PROMPT_CHARACTERS, type CreateImageRequest } from '../../../src/shared/images';
import type { RunReceipt } from '../../../src/shared/runs';

/**
 * A catalogue model exposing the full control set, mirroring Stable Diffusion XL.
 */
const RICH: CatalogueModel = {
  id: '@cf/test/rich',
  name: 'Rich Model',
  provider: 'workers-ai',
  task: 'create-image',
  pricingUnit: 'image',
  documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/rich/',
  imageControls: {
    negativePrompt: true,
    seed: true,
    dimensions: { min: 256, max: 2_048, step: 64, default: 1_024 },
    steps: { min: 1, max: 20, step: 1, default: 20 },
    guidance: { min: 0, max: 20, step: 0.5, default: 7.5 }
  }
};

/**
 * A catalogue model exposing only steps, mirroring FLUX.1 [schnell].
 */
const MINIMAL: CatalogueModel = {
  id: '@cf/test/minimal',
  name: 'Minimal Model',
  provider: 'workers-ai',
  task: 'create-image',
  pricingUnit: 'image',
  documentationUrl: 'https://developers.cloudflare.com/workers-ai/models/minimal/',
  imageControls: {
    negativePrompt: false,
    seed: false,
    steps: { min: 1, max: 8, step: 1, default: 4 }
  }
};

/**
 * Builds a receipt with no gateway log, so tests do not poll unless they mean to.
 *
 * @param overrides Fields to replace.
 * @returns A receipt for a successful response.
 */
function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    runId: 'run-1',
    task: 'create-image',
    model: RICH.id,
    gatewayRouted: true,
    logIds: [],
    status: 'completed',
    costStatus: 'unavailable',
    elapsedMs: 4_200,
    startedAt: '2026-04-01T09:15:00.000Z',
    ...overrides
  };
}

/**
 * Builds a transport that records its requests and returns a canned image.
 *
 * @returns The transport and the requests it received.
 */
function fakeTransport() {
  const requests: CreateImageRequest[] = [];

  /**
   * Returns a successful response for any request.
   *
   * @param request The image request.
   * @returns The canned response.
   */
  async function transport(request: CreateImageRequest) {
    requests.push(request);
    return {
      image: { base64: 'AAAA', mediaType: 'image/png' as const, byteLength: 1_024 },
      receipt: receipt({ runId: request.runId }),
      applied: { prompt: request.prompt, model: request.model, steps: 8 }
    };
  }

  return { transport: transport as never, requests };
}

/**
 * Creates the composable over a reactive model list.
 *
 * @param models Catalogue models to offer.
 * @param transport Generation transport.
 * @returns The composable result.
 */
function create(models: CatalogueModel[], transport?: unknown) {
  return useCreateImage({
    models: ref(models),
    ...(transport === undefined ? {} : { generate: transport as never })
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCreateImage', () => {
  // The catalogue's order is the preference order, so there is no second list to keep in step.
  it('selects the first reviewed model once the catalogue arrives', () => {
    const panel = create([RICH, MINIMAL]);
    expect(panel.model.value).toBe(RICH.id);
  });

  it('exposes the selected model so the view can render its controls', () => {
    const panel = create([RICH, MINIMAL]);
    expect(panel.selectedModel.value?.name).toBe('Rich Model');
  });

  it('settles on a model that arrives after mount', async () => {
    const models = ref<CatalogueModel[]>([]);
    const panel = useCreateImage({ models });

    expect(panel.model.value).toBe('');
    models.value = [MINIMAL];
    await nextTick();

    expect(panel.model.value).toBe(MINIMAL.id);
  });

  describe('canGenerate', () => {
    it('is false for an empty prompt', () => {
      expect(create([RICH]).canGenerate.value).toBe(false);
    });

    it('is false for a whitespace-only prompt', () => {
      const panel = create([RICH]);
      panel.prompt.value = '   ';
      expect(panel.canGenerate.value).toBe(false);
    });

    it('is true once a prompt is typed', () => {
      const panel = create([RICH]);
      panel.prompt.value = 'a lighthouse';
      expect(panel.canGenerate.value).toBe(true);
    });

    it('is false for a prompt over the limit', () => {
      const panel = create([RICH]);
      panel.prompt.value = 'x'.repeat(MAX_PROMPT_CHARACTERS + 1);
      expect(panel.canGenerate.value).toBe(false);
    });

    it('is false before the catalogue has supplied a model', () => {
      const panel = useCreateImage({ models: ref([]) });
      panel.prompt.value = 'a lighthouse';
      expect(panel.canGenerate.value).toBe(false);
    });
  });

  it('does nothing when generate is called with an empty prompt', async () => {
    const { transport, requests } = fakeTransport();
    const panel = create([RICH], transport);

    await panel.generate();
    expect(requests).toEqual([]);
    expect(panel.gallery.value).toEqual([]);
  });

  describe('the request it sends', () => {
    it('sends the trimmed prompt, model, and a fresh run identifier', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = '  a lighthouse  ';
      await panel.generate();

      expect(requests[0]?.prompt).toBe('a lighthouse');
      expect(requests[0]?.model).toBe(RICH.id);
      expect(requests[0]?.runId).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
    });

    // The server rejects an identity field, and the identity comes from the verified Access JWT
    // alone, so the panel must never send one.
    it('sends no identity field', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      for (const field of ['user', 'email', 'actor', 'sub']) {
        expect(Object.keys(requests[0]!)).not.toContain(field);
      }
    });

    it('sends only the prompt, model, and run when no control was set', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(Object.keys(requests[0]!).sort()).toEqual(['model', 'prompt', 'runId']);
    });

    it('sends the controls the visitor set', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      panel.negativePrompt.value = 'people';
      panel.steps.value = 12;
      panel.width.value = 512;
      panel.height.value = 512;
      panel.guidance.value = 6;
      panel.seed.value = 99;
      await panel.generate();

      expect(requests[0]).toMatchObject({
        negativePrompt: 'people',
        steps: 12,
        width: 512,
        height: 512,
        guidance: 6,
        seed: 99
      });
    });

    // Filtering here as well as on the server is not duplicated validation: the server is the
    // authority, and this keeps the panel from ever sending a control the server would refuse.
    it('omits a control the selected model does not declare', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([MINIMAL], transport);

      panel.prompt.value = 'a lighthouse';
      panel.negativePrompt.value = 'people';
      panel.seed.value = 5;
      panel.width.value = 512;
      await panel.generate();

      expect(Object.keys(requests[0]!).sort()).toEqual(['model', 'prompt', 'runId']);
    });

    it('omits an empty negative prompt', async () => {
      const { transport, requests } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      panel.negativePrompt.value = '   ';
      await panel.generate();

      expect(requests[0]).not.toHaveProperty('negativePrompt');
    });
  });

  // Carrying a value across a model switch is the subtle failure this avoids: 20 steps is valid for
  // one model and invalid for the other, so a retained value would turn a model switch into a
  // rejected request for no reason the visitor could see.
  describe('switching model', () => {
    it('clears every control', async () => {
      const models = ref([RICH, MINIMAL]);
      const panel = useCreateImage({ models });

      panel.steps.value = 20;
      panel.width.value = 512;
      panel.guidance.value = 9;
      panel.seed.value = 7;
      panel.negativePrompt.value = 'people';

      panel.model.value = MINIMAL.id;
      await nextTick();

      expect(panel.steps.value).toBeUndefined();
      expect(panel.width.value).toBeUndefined();
      expect(panel.guidance.value).toBeUndefined();
      expect(panel.seed.value).toBeUndefined();
      expect(panel.negativePrompt.value).toBe('');
    });

    it('keeps the prompt, which is still what the visitor wants', async () => {
      const models = ref([RICH, MINIMAL]);
      const panel = useCreateImage({ models });

      panel.prompt.value = 'a lighthouse';
      panel.model.value = MINIMAL.id;
      await nextTick();

      expect(panel.prompt.value).toBe('a lighthouse');
    });

    it('does not send a stale step count after switching to a stricter model', async () => {
      const { transport, requests } = fakeTransport();
      const models = ref([RICH, MINIMAL]);
      const panel = useCreateImage({ models, generate: transport });

      panel.prompt.value = 'a lighthouse';
      panel.steps.value = 20;
      panel.model.value = MINIMAL.id;
      await nextTick();
      await panel.generate();

      expect(requests[0]).not.toHaveProperty('steps');
    });
  });

  describe('results', () => {
    it('adds a generated image to the gallery', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.gallery.value).toHaveLength(1);
      expect(panel.gallery.value[0]?.image.mediaType).toBe('image/png');
    });

    it('records the receipt from the response', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.receipt.value).toBeDefined();
      expect(panel.receipt.value?.task).toBe('create-image');
    });

    it('records the model name beside the result so the gallery can label it', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.gallery.value[0]?.modelName).toBe('Rich Model');
    });

    it('keeps earlier results, newest first', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'first';
      await panel.generate();
      panel.prompt.value = 'second';
      await panel.generate();

      expect(panel.gallery.value).toHaveLength(2);
      expect(panel.gallery.value[0]?.applied.prompt).toBe('second');
    });

    it('clears the generating flag when the run finishes', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.generating.value).toBe(false);
    });
  });

  describe('failures', () => {
    /**
     * Builds a transport that rejects with a given error.
     *
     * @param cause Error to reject with.
     * @returns A transport that always fails.
     */
    function failing(cause: Error) {
      return (() => Promise.reject(cause)) as never;
    }

    it('shows the server\u2019s explanation from an API error', async () => {
      const panel = create(
        [RICH],
        failing(new ApiError(400, 'Rich Model does not support "seed".'))
      );

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.error.value).toBe('Rich Model does not support "seed".');
    });

    it('shows a generic message for an unexpected failure', async () => {
      const panel = create([RICH], failing(new TypeError('network down')));

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.error.value).toMatch(/could not be generated/iu);
      expect(panel.error.value).not.toContain('network down');
    });

    it('adds nothing to the gallery when the run failed', async () => {
      const panel = create([RICH], failing(new ApiError(502, 'nope')));

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.gallery.value).toEqual([]);
    });

    // A failed run has no receipt, so it must not reach the cost meter: a run counted with a cost
    // that can never resolve is exactly the "pending forever" state the meter exists to avoid.
    it('records no run in the ledger when the run failed', async () => {
      const ledger = useLedgerStore();
      const panel = create([RICH], failing(new ApiError(502, 'nope')));

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(ledger.ledger.runCount).toBe(0);
    });

    it('stops generating after a failure', async () => {
      const panel = create([RICH], failing(new ApiError(500, 'nope')));

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.generating.value).toBe(false);
    });

    it('clears a previous error when a new run starts', async () => {
      const { transport } = fakeTransport();
      const panel = create([RICH], transport);
      panel.error.value = 'stale message';

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.error.value).toBeNull();
    });

    // Cancel is the visitor's own action, not a failure, so it leaves no error message.
    it('leaves no error message when the request was aborted', async () => {
      const panel = create([RICH], failing(new DOMException('Aborted', 'AbortError')));

      panel.prompt.value = 'a lighthouse';
      await panel.generate();

      expect(panel.error.value).toBeNull();
    });
  });

  describe('cancellation', () => {
    it('aborts the request in flight', async () => {
      let captured: AbortSignal | undefined;

      /**
       * A transport that waits for its signal to abort.
       *
       * @param _request The image request, unused.
       * @param signal Abort signal from the composable.
       * @returns A promise that rejects on abort.
       */
      const slow = ((_request: CreateImageRequest, signal?: AbortSignal) => {
        captured = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }) as never;

      const panel = create([RICH], slow);
      panel.prompt.value = 'a lighthouse';

      const pending = panel.generate();
      await Promise.resolve();
      panel.cancel();
      await pending;

      expect(captured?.aborted).toBe(true);
      expect(panel.generating.value).toBe(false);
    });

    it('is harmless when nothing is in flight', () => {
      const panel = create([RICH]);
      expect(() => panel.cancel()).not.toThrow();
    });
  });

  // The session meter counts every run, whichever panel produced it, which is the point of keeping
  // the ledger in the shell rather than inside a panel.
  it('records the run in the shared session ledger', async () => {
    const { transport } = fakeTransport();
    const ledger = useLedgerStore();
    const panel = create([RICH], transport);

    panel.prompt.value = 'a lighthouse';
    await panel.generate();

    expect(ledger.ledger.runCount).toBe(1);
  });
});
