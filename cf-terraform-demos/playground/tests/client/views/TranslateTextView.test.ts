import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import { useHandoffStore } from '../../../src/client/stores/handoff';
import TranslateTextView from '../../../src/client/views/TranslateTextView.vue';
import { clickTeleported, openDialogText, panelStubs } from '../support/panel';

/**
 * Navigations the stubbed router recorded.
 */
const pushed: string[] = [];

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: (to: string) => {
      pushed.push(to);
      return Promise.resolve();
    }
  })
}));

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
      { code: 'fr', name: 'French' }
    ],
    targetLanguages: [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' }
    ],
    defaultSourceLanguage: 'en',
    defaultTargetLanguage: 'fr',
    batchesSegments: false,
    outputField: 'translated_text'
  }
};

/**
 * A fixed-source, batching model, matching IndicTrans2.
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
    targetLanguages: [{ code: 'hin_Deva', name: 'Hindi (Devanagari)' }],
    defaultTargetLanguage: 'hin_Deva',
    batchesSegments: true,
    outputField: 'translations'
  }
};

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper and the shared handoff store.
 */
async function render(models: CatalogueModel[] = [PAIRWISE, FIXED_SOURCE]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(TranslateTextView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  await flushPromises();

  return { wrapper, handoff: useHandoffStore(pinia) };
}

beforeEach(() => {
  pushed.length = 0;
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('the view should not reach the network in a test');
    })
  );
});

describe('the panel\u2019s disclosures', () => {
  // Required of every inference panel by `tests/client/privacy-claims.test.ts`. Asserted here too
  // so a reworded disclosure fails in the panel's own test rather than only in the global guard.
  it('warns that the text is logged and advises against confidential input', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your text and its translation are logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  // The panel's central teaching point, stated before any run.
  it('explains that one text can be one billed call or many', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/one accepts a whole passage in a single request/iu);
    expect(text).toMatch(/one billed call or a dozen/iu);
  });

  it('explains how line breaks are preserved and that blank lines are free', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/blank lines are kept in place and are never sent/iu);
  });

  it('states that every model runs on Cloudflare and needs no prepaid credit', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/no prepaid AI Gateway credit/iu);
  });
});

describe('model selection', () => {
  // Standard panels put the ID in `ModelSettingsPanel`, rather than in their native `<option>`
  // labels. Drive a real dropdown with two descriptors so the test proves the copyable ID follows
  // the active value through the view's selected-model computed property.
  it('updates the full model ID when the model dropdown changes', async () => {
    const { wrapper } = await render();

    expect(wrapper.find('[data-model-id]').text()).toBe(PAIRWISE.id);
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);

    expect(wrapper.find('[data-model-id]').text()).toBe(FIXED_SOURCE.id);
    expect(wrapper.text()).not.toContain(PAIRWISE.id);
  });

  it('keeps long model IDs out of the native dropdown labels', async () => {
    const { wrapper } = await render();
    const labels = wrapper.findAll('#translate-model option').map((option) => option.text());

    expect(labels).toEqual([PAIRWISE.name, FIXED_SOURCE.name]);
    expect(labels.join(' ')).not.toContain('@cf/');
  });
});

describe('the language pair', () => {
  it('offers a source selector for a model that has one', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('#translate-source-language').exists()).toBe(true);
  });

  // A disabled control would imply a choice that is temporarily unavailable, when the truth is
  // that this model has no such field.
  it('shows a fixed source as text rather than a disabled selector', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);

    expect(wrapper.find('#translate-source-language').exists()).toBe(false);
    expect(wrapper.find('.fixed-language').text()).toBe('English (Latin)');
  });

  it('explains why a fixed-source model has no source control or swap', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);

    expect(wrapper.text()).toMatch(/no source-language field at all/iu);
    expect(wrapper.text()).toMatch(/nothing to swap/iu);
  });

  it('lists exactly the codes the selected model declares', async () => {
    const { wrapper } = await render();
    const options = wrapper.findAll('#translate-target-language option').map((o) => o.text());

    expect(options).toEqual(['English', 'French']);
  });

  it('switches to the other model\u2019s own codes', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);

    const options = wrapper.findAll('#translate-target-language option').map((o) => o.text());
    expect(options).toEqual(['Hindi (Devanagari)']);
  });

  it('groups the two selectors so their relationship is announced', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('[role="group"][aria-label="Languages"]').exists()).toBe(true);
  });
});

describe('the swap action', () => {
  it('is offered for a bidirectional model', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.swap').exists()).toBe(true);
  });

  // Absent rather than inert. A swap button that silently did nothing would be worse than no
  // button, and the sentence beside the selector explains the absence.
  it('is absent for a model with no source language', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);

    expect(wrapper.find('.swap').exists()).toBe(false);
  });

  it('exchanges the two languages when pressed', async () => {
    const { wrapper } = await render();
    await wrapper.find('.swap').trigger('click');

    // Read through the wrapper's own typed accessor rather than casting the element: a cast to
    // `HTMLSelectElement` here needs a double cast through `unknown`, which the repository rules
    // rightly treat as a sign the approach is wrong.
    expect(wrapper.find<HTMLSelectElement>('#translate-source-language').element.value).toBe('fr');
    expect(wrapper.find<HTMLSelectElement>('#translate-target-language').element.value).toBe('en');
  });

  // An icon-only control needs its own accessible name, and "⇄" is not one.
  it('has an accessible name describing what it does', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.swap').text()).toMatch(/swap the source and target languages/iu);
  });
});

describe('the cost disclosure', () => {
  // The one cost-shaped figure this panel can quote in advance. Both models bill per token, which
  // is not knowable before tokenisation, but the number of paid calls is exact.
  it('states the number of billed calls for a non-batching model', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-source-text').setValue('one\ntwo\nthree');

    expect(wrapper.text()).toMatch(/this will be 3 billed calls/iu);
  });

  it('contrasts it with a model that would make one', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-source-text').setValue('one\ntwo\nthree');

    expect(wrapper.text()).toMatch(/a model that accepts a whole passage at once would make one/iu);
  });

  it('states a single billed call for a batching model', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);
    await wrapper.find('#translate-source-text').setValue('one\ntwo\nthree');

    expect(wrapper.text()).toMatch(/accepts every line in one request/iu);
    expect(wrapper.text()).toMatch(/a single billed call for 3 lines/iu);
  });

  it('describes the selected model\u2019s billing shape in its settings', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toMatch(/one line per request/iu);

    await wrapper.find('#translate-model').setValue(FIXED_SOURCE.id);
    expect(wrapper.text()).toMatch(/a single billed call/iu);
  });

  // The *prediction* is absent until there is text to predict for. The model's billing shape is
  // still described in its settings, which is a property of the model rather than of the request —
  // so the assertion is scoped to the estimate box rather than to the whole panel.
  it('predicts no call count before there is any text', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.cost-estimate').exists()).toBe(false);
  });

  it('still describes the model\u2019s billing shape before there is text', async () => {
    const { wrapper } = await render();
    expect(wrapper.text()).toMatch(/one billed call per line/iu);
  });
});

describe('the composer', () => {
  it('reports the character and line counts against their limits', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-source-text').setValue('one\ntwo');

    expect(wrapper.find('#translate-source-hint').text()).toMatch(/2 of 24 lines/u);
  });

  it('is disabled until there is text', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.translate-button').attributes('disabled')).toBeDefined();
  });

  // Said rather than left to a disabled button, because the reason is not visible in the form.
  it('explains when both languages are the same', async () => {
    const { wrapper } = await render();
    await wrapper.find('#translate-source-text').setValue('something');
    await wrapper.find('#translate-target-language').setValue('en');

    expect(wrapper.text()).toMatch(/nothing to translate/iu);
  });

  it('offers prepared passages without running them', async () => {
    const { wrapper } = await render();
    const examples = wrapper.findAll('.example');
    expect(examples.length).toBeGreaterThan(0);

    await examples[1]?.trigger('click');

    const textarea = wrapper.find<HTMLTextAreaElement>('#translate-source-text').element;
    expect(textarea.value).toContain('\n');
    // A prepared passage that spent credit the moment it was clicked would be a trap, and this
    // panel's per-line billing makes that sharper than elsewhere.
    expect(pushed).toEqual([]);
  });

  // The example whose whole purpose is the cost comparison, so it must really be multi-line.
  it('includes a multi-line example that demonstrates the call count', async () => {
    const { wrapper } = await render();
    await wrapper.findAll('.example')[1]?.trigger('click');

    expect(wrapper.text()).toMatch(/billed calls/iu);
  });

  it('links to the selected model\u2019s catalogue page', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.docs-link a').attributes('href')).toBe(PAIRWISE.documentationUrl);
  });

  it('shows no output column before a run', async () => {
    const { wrapper } = await render();
    expect(wrapper.find('.handoff').exists()).toBe(false);
  });
});

describe('the Read Text handoff', () => {
  /**
   * Runs a translation through the real composable by stubbing the transport.
   *
   * @returns The mounted wrapper and the handoff store.
   */
  async function translateOnce() {
    const mounted = await render();

    // The composable's own transport is the module-level `translateText`, so the run is driven by
    // stubbing `fetch` rather than by injecting — which is what the view really does.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
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
                logIds: [],
                status: 'completed',
                costStatus: 'unavailable',
                elapsedMs: 10,
                startedAt: new Date().toISOString()
              },
              applied: {
                model: PAIRWISE.id,
                sourceLanguage: 'en',
                targetLanguage: 'fr',
                characterCount: 13,
                inferenceCallCount: 1
              }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );

    await mounted.wrapper.find('#translate-source-text').setValue('a translation');
    await mounted.wrapper.find('.translate-button').trigger('click');
    await flushPromises();

    return mounted;
  }

  it('offers the handoff only once a translation exists', async () => {
    const { wrapper } = await translateOnce();
    expect(wrapper.find('.handoff').exists()).toBe(true);
  });

  // The phase-9 contract's first real producer, and the deliverable that completes it.
  it('hands the translation to Read Text through the shared store', async () => {
    const { wrapper, handoff } = await translateOnce();
    await wrapper.find('.handoff button').trigger('click');

    expect(handoff.pendingText?.text).toBe('une traduction');
    expect(pushed).toEqual(['/read-text']);
  });

  // The reason the handoff is worth having at all: a French translation read by an English voice
  // would be a worse result than no handoff.
  it('sends the target language so the next panel can match a voice', async () => {
    const { wrapper, handoff } = await translateOnce();
    await wrapper.find('.handoff button').trigger('click');

    expect(handoff.pendingText?.language).toBe('fr');
  });

  it('describes where the text came from', async () => {
    const { wrapper, handoff } = await translateOnce();
    await wrapper.find('.handoff button').trigger('click');

    expect(handoff.pendingText?.origin).toMatch(/translated into french/iu);
  });

  // Secondary by design: the specification is explicit that this is optional functionality rather
  // than part of the primary run path.
  it('places the handoff below the result rather than beside the run button', async () => {
    const { wrapper } = await translateOnce();
    const html = wrapper.html();

    expect(html.indexOf('translation')).toBeLessThan(html.indexOf('Read this aloud'));
  });

  it('warns that a long translation will be shortened', async () => {
    const { wrapper } = await translateOnce();
    expect(wrapper.find('.handoff').text()).toMatch(/shortened to what that panel accepts/iu);
  });
});
