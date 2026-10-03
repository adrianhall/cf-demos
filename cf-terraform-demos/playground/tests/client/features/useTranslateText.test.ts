import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createTestingPinia } from '@pinia/testing';
import { useTranslateText } from '../../../src/client/features/translate-text/useTranslateText';
import { ApiError } from '../../../src/client/services/playground-api';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import {
  MAX_TRANSLATION_SEGMENTS,
  type TranslateTextResponse
} from '../../../src/shared/translate-text';

/**
 * A bidirectional, non-batching model with a source control, matching M2M100.
 */
const PAIRWISE: CatalogueModel = {
  id: '@cf/test/pairwise',
  name: 'Test Pairwise',
  provider: 'workers-ai',
  task: 'translate-text',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/pairwise',
  translationControls: {
    targetParameterName: 'target_lang',
    sourceParameterName: 'source_lang',
    sourceLanguages: [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' },
      { code: 'de', name: 'German' }
    ],
    targetLanguages: [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' },
      { code: 'de', name: 'German' }
    ],
    defaultSourceLanguage: 'en',
    defaultTargetLanguage: 'fr',
    batchesSegments: false,
    outputField: 'translated_text'
  }
};

/**
 * A fixed-source, batching model with codes in a different standard, matching IndicTrans2.
 *
 * The different code spellings are the point: they are what proves the composable re-settles a
 * language on model change rather than carrying over a value the new model would reject.
 */
const FIXED_SOURCE: CatalogueModel = {
  id: '@cf/test/fixed',
  name: 'Test Fixed Source',
  provider: 'workers-ai',
  task: 'translate-text',
  pricingUnit: 'token',
  documentationUrl: 'https://example.invalid/fixed',
  translationControls: {
    targetParameterName: 'target_language',
    fixedSourceLanguage: { code: 'eng_Latn', name: 'English (Latin)' },
    targetLanguages: [
      { code: 'hin_Deva', name: 'Hindi (Devanagari)' },
      { code: 'tam_Taml', name: 'Tamil (Tamil)' }
    ],
    defaultTargetLanguage: 'hin_Deva',
    batchesSegments: true,
    outputField: 'translations'
  }
};

/**
 * Builds a successful response.
 *
 * @param overrides Fields to replace.
 * @returns The response a transport should resolve with.
 */
function response(overrides: Partial<TranslateTextResponse> = {}): TranslateTextResponse {
  return {
    translation: {
      text: 'une traduction',
      segments: [{ source: 'a translation', translated: 'une traduction', blank: false }],
      translatedLineCount: 1,
      inferenceCallCount: 1
    },
    receipt: {
      runId: 'run-1',
      task: 'translate-text',
      model: PAIRWISE.id,
      gatewayRouted: true,
      logIds: ['log-1'],
      status: 'completed',
      costStatus: 'pending',
      elapsedMs: 400,
      startedAt: new Date().toISOString()
    },
    applied: {
      model: PAIRWISE.id,
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      characterCount: 13,
      inferenceCallCount: 1
    },
    ...overrides
  };
}

/**
 * Builds the composable with an injected transport.
 *
 * @param models Catalogue models to offer.
 * @param transport Transport to use.
 * @returns The composable result, with the transport exposed under its own name.
 */
function build(
  models: CatalogueModel[] = [PAIRWISE, FIXED_SOURCE],
  transport = vi.fn().mockResolvedValue(response())
) {
  const result = useTranslateText({
    models: ref(models),
    translate: transport,
    // Resolve polls immediately rather than waiting seconds of real time.
    runOptions: { sleep: async () => undefined }
  });

  // Exposed as `transport` rather than merged over the composable's own `run` action, which it
  // would otherwise shadow — leaving every test calling the mock directly instead of the code
  // under test, and passing for the wrong reason.
  return { ...result, transport };
}

beforeEach(() => {
  setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
});

describe('selecting a model', () => {
  it('defaults to the first reviewed model once the catalogue arrives', () => {
    expect(build().model.value).toBe(PAIRWISE.id);
  });

  it('applies the selected model\u2019s default languages', () => {
    const panel = build();
    expect(panel.sourceLanguage.value).toBe('en');
    expect(panel.targetLanguage.value).toBe('fr');
  });

  it('exposes the selected model descriptor', () => {
    expect(build().selectedModel.value?.name).toBe('Test Pairwise');
  });
});

describe('re-settling languages when the model changes', () => {
  // The two reviewed models use different standards, so a carried-over code would usually be
  // invalid rather than merely unusual.
  it('replaces a language the new model does not declare', async () => {
    const panel = build();
    panel.targetLanguage.value = 'de';

    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    expect(panel.targetLanguage.value).toBe('hin_Deva');
  });

  it('keeps a language the new model also declares', async () => {
    const panel = build([PAIRWISE, { ...FIXED_SOURCE, id: '@cf/test/other' }]);
    panel.targetLanguage.value = 'de';

    // Back to the same model: nothing should move.
    panel.model.value = PAIRWISE.id;
    await nextTick();

    expect(panel.targetLanguage.value).toBe('de');
  });

  // A fixed-source model has no source control, so any selection must be discarded rather than
  // retained invisibly and sent on a later model switch.
  it('clears the source language for a fixed-source model', async () => {
    const panel = build();
    panel.sourceLanguage.value = 'de';

    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    expect(panel.sourceLanguage.value).toBeUndefined();
  });

  it('restores a source language when switching back', async () => {
    const panel = build();
    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    panel.model.value = PAIRWISE.id;
    await nextTick();

    expect(panel.sourceLanguage.value).toBe('en');
  });

  it('exposes the fixed source language for display', async () => {
    const panel = build();
    expect(panel.fixedSourceLanguage.value).toBeUndefined();

    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    expect(panel.fixedSourceLanguage.value?.name).toBe('English (Latin)');
  });

  it('offers only the selected model\u2019s own language lists', async () => {
    const panel = build();
    expect(panel.sourceLanguages.value.map((l) => l.code)).toContain('fr');

    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    expect(panel.sourceLanguages.value).toEqual([]);
    expect(panel.targetLanguages.value.map((l) => l.code)).toEqual(['hin_Deva', 'tam_Taml']);
  });
});

describe('the swap action', () => {
  it('exchanges the source and target languages', () => {
    const panel = build();
    panel.swap();

    expect(panel.sourceLanguage.value).toBe('fr');
    expect(panel.targetLanguage.value).toBe('en');
  });

  // Swapping is overwhelmingly done to check a translation back the other way, so leaving the
  // original text in place would mean copying the result across by hand.
  it('moves an existing translation into the source box', async () => {
    const panel = build();
    panel.text.value = 'a translation';
    await panel.run();

    panel.swap();

    expect(panel.text.value).toBe('une traduction');
  });

  // The stale result would otherwise sit beside a source it no longer corresponds to.
  it('clears the previous result when swapping', async () => {
    const panel = build();
    panel.text.value = 'a translation';
    await panel.run();

    panel.swap();

    expect(panel.translation.value).toBeUndefined();
    expect(panel.receipt.value).toBeUndefined();
  });

  it('leaves the text alone when there is no translation yet', () => {
    const panel = build();
    panel.text.value = 'untranslated';

    panel.swap();

    expect(panel.text.value).toBe('untranslated');
  });

  // The finding that shapes the panel: there is nothing to exchange for a model with no source
  // control, so the action is reported unavailable rather than rendered and left inert.
  it('is unavailable for a model with no source language', async () => {
    const panel = build();
    expect(panel.canSwap.value).toBe(true);

    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    expect(panel.canSwap.value).toBe(false);
  });

  it('does nothing when called while unavailable', async () => {
    const panel = build();
    panel.model.value = FIXED_SOURCE.id;
    await nextTick();

    panel.swap();

    expect(panel.sourceLanguage.value).toBeUndefined();
    expect(panel.targetLanguage.value).toBe('hin_Deva');
  });

  // A model whose source and target lists differ would otherwise offer a swap producing an invalid
  // pair. Not true of the reviewed models, which is exactly why it needs a test.
  it('is unavailable when the target is not also an accepted source', async () => {
    const asymmetric: CatalogueModel = {
      ...PAIRWISE,
      id: '@cf/test/asymmetric',
      translationControls: {
        ...PAIRWISE.translationControls!,
        sourceLanguages: [{ code: 'en', name: 'English' }],
        targetLanguages: [{ code: 'fr', name: 'French' }],
        defaultTargetLanguage: 'fr'
      }
    };

    const panel = build([asymmetric]);
    await nextTick();

    expect(panel.canSwap.value).toBe(false);
  });
});

describe('predicting the number of paid calls', () => {
  // The panel's central disclosure: the same passage is one charge on one model and several on the
  // other.
  it('predicts one call per line for a non-batching model', () => {
    const panel = build();
    panel.text.value = 'one\ntwo\nthree';

    expect(panel.predictedCallCount.value).toBe(3);
  });

  it('predicts a single call for a batching model', async () => {
    const panel = build();
    panel.model.value = FIXED_SOURCE.id;
    await nextTick();
    panel.text.value = 'one\ntwo\nthree';

    expect(panel.predictedCallCount.value).toBe(1);
  });

  it('counts only translatable lines', () => {
    const panel = build();
    panel.text.value = 'one\n\n\ntwo';

    expect(panel.translatableLineCount.value).toBe(2);
    expect(panel.predictedCallCount.value).toBe(2);
  });

  it('predicts nothing for empty text', () => {
    expect(build().predictedCallCount.value).toBe(0);
  });
});

describe('whether the panel can be submitted', () => {
  it('refuses with no text', () => {
    expect(build().canTranslate.value).toBe(false);
  });

  it('accepts once there is text', () => {
    const panel = build();
    panel.text.value = 'something';

    expect(panel.canTranslate.value).toBe(true);
  });

  it('refuses while a run is in flight', async () => {
    const panel = build();
    panel.text.value = 'something';

    const running = panel.run();
    expect(panel.canTranslate.value).toBe(false);
    await running;
  });

  // Said rather than left to a disabled button: the reason is not obvious from the form.
  it('refuses and explains when there are too many lines', () => {
    const panel = build();
    panel.text.value = Array.from(
      { length: MAX_TRANSLATION_SEGMENTS + 1 },
      (_u, i) => `l${i}`
    ).join('\n');

    expect(panel.canTranslate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/lines rather than length/u);
  });

  it('refuses and explains when both languages are the same', () => {
    const panel = build();
    panel.text.value = 'something';
    panel.targetLanguage.value = 'en';

    expect(panel.canTranslate.value).toBe(false);
    expect(panel.blockedReason.value).toMatch(/nothing to translate/u);
  });

  // The fixed source counts for this check too, even though there is no control the visitor could
  // have set wrongly.
  it('refuses a target matching a fixed source language', async () => {
    const panel = build([
      {
        ...FIXED_SOURCE,
        translationControls: {
          ...FIXED_SOURCE.translationControls!,
          targetLanguages: [{ code: 'eng_Latn', name: 'English (Latin)' }],
          defaultTargetLanguage: 'eng_Latn'
        }
      }
    ]);
    await nextTick();
    panel.text.value = 'something';

    expect(panel.canTranslate.value).toBe(false);
  });

  it('reports no blocking reason when the form is valid', () => {
    const panel = build();
    panel.text.value = 'something';

    expect(panel.blockedReason.value).toBeNull();
  });
});

describe('building the request', () => {
  it('sends the text, model, and target language', async () => {
    const panel = build();
    panel.text.value = 'a translation';
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'a translation',
        model: PAIRWISE.id,
        runId: 'run-1',
        targetLanguage: 'fr'
      }),
      expect.anything()
    );
  });

  // The text goes as the visitor wrote it: the server does the segmenting, so a browser splitting
  // it could stage a different number of paid calls than the server would make.
  it('sends the text with its line breaks intact', async () => {
    const panel = build();
    panel.text.value = 'one\n\ntwo';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(sent?.['text']).toBe('one\n\ntwo');
  });

  it('sends a chosen source language', async () => {
    const panel = build();
    panel.text.value = 'x';
    panel.sourceLanguage.value = 'de';
    await panel.run();

    expect(panel.transport).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLanguage: 'de' }),
      expect.anything()
    );
  });

  // The server refuses a source language on a fixed-source model, so offering the chance to send
  // one would stage a request already known to be invalid.
  it('never sends a source language to a fixed-source model', async () => {
    const panel = build();
    panel.model.value = FIXED_SOURCE.id;
    await nextTick();
    panel.text.value = 'x';
    await panel.run();

    expect(panel.transport.mock.calls[0]?.[0]).not.toHaveProperty('sourceLanguage');
  });

  // This is the assertion that would catch a stale code surviving a model switch and being
  // forwarded under a standard the new model does not use.
  it('never sends a source language the selected model does not declare', async () => {
    const panel = build();
    // Set directly, as a stale value surviving a reset would be.
    panel.sourceLanguage.value = 'eng_Latn';
    panel.text.value = 'x';
    await panel.run();

    expect(panel.transport.mock.calls[0]?.[0]).not.toHaveProperty('sourceLanguage');
  });

  // No identity field, and no way to supply one: the actor comes from the verified Access JWT.
  it('never sends an identity field', async () => {
    const panel = build();
    panel.text.value = 'x';
    await panel.run();

    const sent = panel.transport.mock.calls[0]?.[0] as Record<string, unknown>;
    for (const field of ['user', 'email', 'actor', 'sub']) {
      expect(sent, field).not.toHaveProperty(field);
    }
  });
});

describe('a successful run', () => {
  it('exposes the translation, receipt, and applied controls', async () => {
    const panel = build();
    panel.text.value = 'a translation';
    await panel.run();

    expect(panel.translation.value?.text).toBe('une traduction');
    expect(panel.receipt.value?.runId).toBe('run-1');
    expect(panel.applied.value?.targetLanguage).toBe('fr');
  });

  it('clears the busy flag when the run finishes', async () => {
    const panel = build();
    panel.text.value = 'x';
    await panel.run();

    expect(panel.translating.value).toBe(false);
  });

  it('reports the call count the server actually made', async () => {
    const panel = build(
      [PAIRWISE],
      vi.fn().mockResolvedValue(
        response({
          translation: {
            text: 'un\ndeux',
            segments: [
              { source: 'one', translated: 'un', blank: false },
              { source: 'two', translated: 'deux', blank: false }
            ],
            translatedLineCount: 2,
            inferenceCallCount: 2
          }
        })
      )
    );
    panel.text.value = 'one\ntwo';
    await panel.run();

    expect(panel.translation.value?.inferenceCallCount).toBe(2);
  });
});

describe('failures', () => {
  it('shows the server\u2019s own message for an API failure', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new ApiError(400, 'Test Pairwise does not accept that language.'));
    const panel = build([PAIRWISE], transport);
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toBe('Test Pairwise does not accept that language.');
  });

  it('falls back to a generic message for a transport failure', async () => {
    const panel = build([PAIRWISE], vi.fn().mockRejectedValue(new Error('offline')));
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toMatch(/could not be translated/u);
  });

  // An abort is the visitor's own Cancel, not a failure, so it leaves no error message.
  it('reports no error when the visitor cancels', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const panel = build([PAIRWISE], vi.fn().mockRejectedValue(abort));
    panel.text.value = 'x';
    await panel.run();

    expect(panel.error.value).toBeNull();
  });

  it('aborts the request when cancelled', async () => {
    const panel = build();
    panel.text.value = 'x';

    const running = panel.run();
    panel.cancel();
    await running;

    const signal = panel.transport.mock.calls[0]?.[1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('clears a previous error on the next attempt', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, 'Provider failed.'))
      .mockResolvedValueOnce(response());
    const panel = build([PAIRWISE], transport);
    panel.text.value = 'x';

    await panel.run();
    expect(panel.error.value).toBe('Provider failed.');

    await panel.run();
    expect(panel.error.value).toBeNull();
  });
});
