import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import { useHandoffStore } from '../../../src/client/stores/handoff';
import ReadTextView from '../../../src/client/views/ReadTextView.vue';
import { MAX_SPEECH_CHARACTERS } from '../../../src/shared/read-text';
import { clickTeleported, isDialogOpen, openDialogText, panelStubs } from '../support/panel';

/**
 * A voice-based model billed per character, matching the reviewed Aura 2 contract.
 */
const AURA: CatalogueModel = {
  id: '@cf/test/aura',
  name: 'Test Aura',
  provider: 'workers-ai',
  task: 'read-text',
  pricingUnit: 'provider-reported',
  documentationUrl: 'https://example.invalid/aura',
  speechControls: {
    textParameterName: 'text',
    voices: ['luna', 'orion'],
    defaultVoice: 'luna',
    formats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    pricePerThousandCharactersUsd: 0.03
  }
};

/**
 * A language-based model with no voice control and no character pricing, matching MeloTTS.
 */
const MELO: CatalogueModel = {
  id: '@cf/test/melo',
  name: 'Test Melo',
  provider: 'workers-ai',
  task: 'read-text',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/melo',
  speechControls: {
    textParameterName: 'prompt',
    languages: ['en', 'fr'],
    defaultLanguage: 'en',
    languageSelectsVoice: true
  }
};

/**
 * A successful run, as the endpoint returns it.
 */
const RESULT = {
  speech: { base64: 'SUQzAwA=', mediaType: 'audio/mpeg' as const, byteLength: 2_048 },
  receipt: {
    runId: 'run-1',
    task: 'read-text' as const,
    model: AURA.id,
    gatewayRouted: true,
    logIds: ['log-1'],
    status: 'completed' as const,
    costStatus: 'available' as const,
    elapsedMs: 120,
    startedAt: new Date().toISOString()
  },
  applied: {
    model: AURA.id,
    characterCount: 12,
    voice: 'luna',
    format: 'mp3' as const,
    estimatedCostUsd: 0.000_36
  }
};

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [AURA, MELO]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(ReadTextView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(RESULT), { status: 200 }))
  );
});

describe('the panel\u2019s disclosures', () => {
  // Required of every inference panel by `tests/client/privacy-claims.test.ts`. Asserted here too
  // so a reworded disclosure fails in the panel's own test rather than only in the global guard.
  it('warns that the text is logged and advises against confidential input', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your text is logged/iu);
    expect(text).toMatch(/nothing confidential|anything confidential/iu);
  });

  // The reason this panel could be delivered in phase 9 while Animate Image waits. Stating it is
  // part of the panel's teaching value, not incidental.
  it('states that every voice runs on Cloudflare and needs no prepaid credit', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/no prepaid AI Gateway credit/iu);
  });
});

describe('the composer', () => {
  it('shows the character count against the limit', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('hello');

    expect(wrapper.text()).toContain(`5 of ${MAX_SPEECH_CHARACTERS.toLocaleString()} characters`);
  });

  // Stated rather than only enforced: discovering a limit by being refused is a worse experience
  // than being told where it is.
  it('says what to do when the text is too long', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('a'.repeat(MAX_SPEECH_CHARACTERS + 1));

    expect(wrapper.text()).toMatch(/shorten the text to continue/iu);
  });

  it('disables the submit button until something is typed', async () => {
    const wrapper = await render();
    expect(wrapper.find('.speak-button').attributes('disabled')).toBeDefined();

    await wrapper.find('#speech-text').setValue('hello');
    expect(wrapper.find('.speak-button').attributes('disabled')).toBeUndefined();
  });

  it('offers prepared passages that load without running', async () => {
    const wrapper = await render();
    const buttons = wrapper.findAll('.example-button');
    expect(buttons.length).toBeGreaterThan(0);

    await buttons[0]!.trigger('click');

    expect(
      (wrapper.find('#speech-text').element as HTMLTextAreaElement).value.length
    ).toBeGreaterThan(0);
    // A prepared passage that spent credit the moment it was clicked would be a trap.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the cost estimate', () => {
  // The first panel able to quote a cost before a synchronous request, because the billable
  // quantity is text the visitor has already typed.
  it('quotes an estimate for a character-priced model', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('a'.repeat(1_000));

    expect(wrapper.text()).toMatch(/Estimated cost for 1,000 characters: \$0\.0300/u);
  });

  it('names the rate before anything is typed', async () => {
    expect((await render()).text()).toMatch(/per 1,000 characters/iu);
  });

  // Four decimal places, because a short passage genuinely costs a fraction of a cent and rounding
  // to two would display `$0.00` — a figure that reads as free.
  it('shows enough precision that a cheap run does not read as free', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('hello');

    expect(wrapper.text()).not.toMatch(/Estimated cost[^.]*\$0\.00\b/u);
  });

  // Saying why is better than showing a zero, which would read as "free".
  it('explains that a minute-priced model cannot be estimated', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-model').setValue(MELO.id);
    await wrapper.find('#speech-text').setValue('hello');

    expect(wrapper.text()).toMatch(/billed per minute of generated audio/iu);
    expect(wrapper.text()).not.toMatch(/Estimated cost/u);
  });
});

describe('per-model controls', () => {
  it('offers a voice selector for a model that publishes voices', async () => {
    const wrapper = await render();

    expect(wrapper.find('#speech-voice').exists()).toBe(true);
    expect(wrapper.find('#speech-language').exists()).toBe(false);
  });

  // The sharpest demonstration of the per-model declaration: the controls themselves appear and
  // disappear rather than merely changing range.
  it('offers a language selector instead for a model that publishes languages', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-model').setValue(MELO.id);

    expect(wrapper.find('#speech-language').exists()).toBe(true);
    expect(wrapper.find('#speech-voice').exists()).toBe(false);
  });

  it('lists exactly the voices the selected model publishes', async () => {
    const wrapper = await render();
    const options = wrapper.findAll('#speech-voice option').map((option) => option.text());

    for (const voice of AURA.speechControls!.voices!) {
      expect(options.join(' ')).toContain(voice);
    }
  });

  // The honest version of a missing control. A visitor who finds no voice selector should learn
  // that the model has no voice parameter, rather than wondering whether the page failed to load.
  it('explains why a model with a language has no voice control', async () => {
    const wrapper = await render();
    await wrapper.find('#speech-model').setValue(MELO.id);

    expect(wrapper.text()).toMatch(/no voice parameter at all/iu);
  });

  it('explains that a voice determines the language on the other family', async () => {
    expect((await render()).text()).toMatch(/takes no language parameter/iu);
  });

  it('offers a format selector only where the model offers a choice', async () => {
    const wrapper = await render();
    expect(wrapper.find('#speech-format').exists()).toBe(true);

    await wrapper.find('#speech-model').setValue(MELO.id);
    expect(wrapper.find('#speech-format').exists()).toBe(false);
  });

  // The reviewed answer to the phase brief's "rate and pitch when supported". Saying so is the
  // finding; offering nothing silently would leave a reader wondering whether the panel forgot.
  it('states that no reviewed model exposes rate or pitch', async () => {
    expect((await render()).text()).toMatch(/expose a speaking rate or pitch control/iu);
  });

  it('links to the selected model\u2019s catalogue page', async () => {
    const wrapper = await render();
    expect(wrapper.find('.docs-link a').attributes('href')).toBe(AURA.documentationUrl);
  });
});

describe('a completed run', () => {
  /**
   * Runs the panel once and returns the wrapper.
   *
   * @returns The mounted wrapper after a successful run.
   */
  async function runOnce() {
    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('Hello there.');
    await wrapper.find('.speak-button').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('renders a native audio player', async () => {
    const wrapper = await runOnce();
    const audio = wrapper.find('audio');

    expect(audio.exists()).toBe(true);
    // Native controls rather than custom transport buttons: keyboard-operable, announced correctly,
    // and honouring the system media keys without any of it being reimplemented.
    expect(audio.attributes('controls')).toBeDefined();
    expect(audio.attributes('src')).toBe('data:audio/mpeg;base64,SUQzAwA=');
  });

  // The accessible equivalent, and the substance of the output rather than a decoration on it.
  // Audio is the one output in this demo some visitors cannot perceive at all.
  it('shows the spoken text as the audio\u2019s alternative', async () => {
    const wrapper = await runOnce();

    expect(wrapper.find('.spoken-text').text()).toBe('Hello there.');
    expect(wrapper.text()).toMatch(/text that was read/iu);
  });

  it('offers a download named from the run and the sniffed format', async () => {
    const link = (await runOnce()).find('.download');

    expect(link.attributes('download')).toBe('playground-run-1.mp3');
    expect(link.attributes('href')).toBe('data:audio/mpeg;base64,SUQzAwA=');
  });

  it('reports the format and size', async () => {
    const text = (await runOnce()).text();

    expect(text).toContain('audio/mpeg');
    expect(text).toMatch(/2(\.0)? KB|2,048/u);
  });

  it('reports the controls that were applied', async () => {
    const text = (await runOnce()).text();

    expect(text).toContain('luna');
    expect(text).toMatch(/Characters/u);
  });

  it('opens the run details on request', async () => {
    const wrapper = await runOnce();
    expect(isDialogOpen()).toBe(false);

    await wrapper.find('.run-details-button').trigger('click');
    expect(isDialogOpen()).toBe(true);
  });
});

describe('accepting a handoff', () => {
  // Built and tested now, ahead of Translate Text in phase 11, so the contract exists before the
  // panel that uses it rather than being retrofitted.
  it('loads text another panel offered and names its origin', async () => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    const catalogue = useCatalogueStore(pinia);
    catalogue.load = vi.fn(async () => undefined);
    catalogue.models = [AURA, MELO];
    catalogue.loaded = true;

    const handoff = useHandoffStore(pinia);
    handoff.offerText({ text: 'Bonjour le monde', origin: 'Translated into French' });

    const wrapper = mount(ReadTextView, {
      global: { plugins: [pinia], stubs: panelStubs() }
    });
    await flushPromises();

    expect((wrapper.find('#speech-text').element as HTMLTextAreaElement).value).toBe(
      'Bonjour le monde'
    );
    expect(wrapper.text()).toContain('Translated into French');
  });
});

describe('failures', () => {
  it('shows the server\u2019s own explanation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Test Aura does not support "language".' }), {
            status: 400
          })
      )
    );

    const wrapper = await render();
    await wrapper.find('#speech-text').setValue('hello');
    await wrapper.find('.speak-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.error').text()).toContain('does not support');
  });
});
