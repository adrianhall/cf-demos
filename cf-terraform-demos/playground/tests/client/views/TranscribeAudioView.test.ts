import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import TranscribeAudioView from '../../../src/client/views/TranscribeAudioView.vue';
import { clickTeleported, openDialogText, panelStubs } from '../support/panel';

/**
 * A base64 model with a large ceiling and a context prompt, matching Whisper large v3 turbo.
 */
const TURBO: CatalogueModel = {
  id: '@cf/test/turbo',
  name: 'Test Turbo',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/turbo',
  transcriptionControls: {
    audioEncoding: 'base64',
    maxAudioBytes: 4 * 1_024 * 1_024,
    languages: ['en', 'fr'],
    supportsContextPrompt: true,
    timestampGranularity: 'segment',
    confidenceScale: 'log-probability',
    pricePerAudioMinuteUsd: 0.000_5
  }
};

/**
 * A model with every flag control, matching Nova 3.
 */
const NOVA: CatalogueModel = {
  id: '@cf/test/nova',
  name: 'Test Nova',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/nova',
  transcriptionControls: {
    audioEncoding: 'body-object',
    maxAudioBytes: 4 * 1_024 * 1_024,
    languages: ['en', 'en-GB'],
    supportsLanguageDetection: true,
    supportsDiarization: true,
    supportsPunctuation: true,
    timestampGranularity: 'word',
    confidenceScale: 'probability',
    pricePerAudioMinuteUsd: 0.005_2
  }
};

/**
 * A byte-array model with a much smaller ceiling and no controls, matching the original Whisper.
 */
const SMALL: CatalogueModel = {
  id: '@cf/test/small',
  name: 'Test Small',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/small',
  transcriptionControls: {
    audioEncoding: 'byte-array',
    maxAudioBytes: 1_024 * 1_024,
    timestampGranularity: 'word',
    pricePerAudioMinuteUsd: 0.000_5
  }
};

/**
 * A model publishing no rate at all, matching Whisper Tiny EN.
 *
 * The catalogue carries no pricing property for that model and its documentation page has no Unit
 * Pricing row, so the panel has to describe the absence rather than format it.
 */
const UNPRICED: CatalogueModel = {
  id: '@cf/test/unpriced',
  name: 'Test Unpriced',
  provider: 'workers-ai',
  task: 'transcribe-audio',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/unpriced',
  transcriptionControls: {
    audioEncoding: 'byte-array',
    maxAudioBytes: 1_024 * 1_024,
    timestampGranularity: 'word'
  }
};

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [TURBO, NOVA, SMALL]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(TranscribeAudioView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
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
  it('warns that the recording is logged and advises against confidential input', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your recording and its transcript are logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  // The microphone must be clearly optional: a panel that appeared to require it would be
  // unusable for anyone who declines, and declining is reasonable when a page asks to listen.
  it('states that the microphone is optional', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/recording from your microphone is optional/iu);
  });

  it('states that every model runs on Cloudflare and needs no prepaid credit', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/no prepaid AI Gateway credit/iu);
  });
});

describe('per-model controls', () => {
  it('offers a language selector for a model that publishes one', async () => {
    expect((await render()).find('#transcribe-language').exists()).toBe(true);
  });

  // The model with no language parameter at all gets no selector, rather than a disabled one: a
  // control the provider would reject has no honest disabled state.
  it('offers no language selector for the model that takes none', async () => {
    const wrapper = await render();
    await wrapper.find('#transcribe-model').setValue(SMALL.id);

    expect(wrapper.find('#transcribe-language').exists()).toBe(false);
  });

  it('lists exactly the codes the selected model publishes', async () => {
    const wrapper = await render();
    const options = wrapper.findAll('#transcribe-language option').map((o) => o.text());

    expect(options.join(' ')).toContain('fr');
    // A BCP-47 tag belongs to the other model, and the two standards are not merged.
    expect(options.join(' ')).not.toContain('en-GB');
  });

  it('offers the flag controls only for the model that supports them', async () => {
    const wrapper = await render();
    expect(wrapper.text()).not.toMatch(/label who is speaking/iu);

    await wrapper.find('#transcribe-model').setValue(NOVA.id);

    expect(wrapper.text()).toMatch(/label who is speaking/iu);
    expect(wrapper.text()).toMatch(/add punctuation/iu);
  });

  it('offers a context prompt only for the model that accepts one', async () => {
    const wrapper = await render();
    expect(wrapper.find('#transcribe-context').exists()).toBe(true);

    await wrapper.find('#transcribe-model').setValue(NOVA.id);

    expect(wrapper.find('#transcribe-context').exists()).toBe(false);
  });

  it('links to the selected model\u2019s catalogue page', async () => {
    expect((await render()).find('.docs-link a').attributes('href')).toBe(TURBO.documentationUrl);
  });
});

describe('the per-model size limit', () => {
  it('states the limit for the selected model', async () => {
    expect((await render()).text()).toMatch(/accepts files up to 4\.0 MB/u);
  });

  // The explanation is the point. A lower limit with no reason given reads as an arbitrary
  // restriction or a bug, when it is a property of the model's contract.
  it('explains why one model\u2019s limit is lower than the others', async () => {
    const wrapper = await render();
    await wrapper.find('#transcribe-model').setValue(SMALL.id);

    expect(wrapper.text()).toMatch(/accepts files up to 1\.0 MB/u);
    expect(wrapper.text()).toMatch(/JSON array of byte values/iu);
  });

  it('does not explain a limit that matches the panel ceiling', async () => {
    expect((await render()).text()).not.toMatch(/JSON array of byte values/iu);
  });
});

describe('the cost disclosure', () => {
  it('states the per-minute rate for the selected model', async () => {
    expect((await render()).text()).toMatch(/\$0\.0005 per audio minute/u);
  });

  it('states the higher rate for the more expensive model', async () => {
    const wrapper = await render();
    await wrapper.find('#transcribe-model').setValue(NOVA.id);

    expect(wrapper.text()).toMatch(/\$0\.0052 per audio minute/u);
  });

  // Unlike Read Text, this panel usually cannot estimate before the run: a compressed file's
  // duration is not readable in the browser. Saying so beats leaving the figure mysteriously
  // absent.
  it('explains that the cost depends on a length it can rarely measure in advance', async () => {
    expect((await render()).text()).toMatch(/only measure for WAV files before sending/iu);
  });

  // The regression this guards is a formatting one with a factual consequence. An absent rate run
  // through `toFixed(4)` throws, and "fixing" that with `?? 0` would render `$0.0000` — which a
  // visitor reads as "this model is free". The panel must say no rate is published instead.
  it('states that an unpriced model publishes no rate rather than showing a zero', async () => {
    const wrapper = await render([TURBO, UNPRICED]);
    await wrapper.find('#transcribe-model').setValue(UNPRICED.id);

    expect(wrapper.text()).toMatch(/publishes no per-minute rate/iu);
    expect(wrapper.text()).not.toMatch(/\$0\.0000/u);
  });
});

describe('the confidence disclosure', () => {
  // The most important thing a visitor can learn when switching models here. "Confidence" means
  // different things for the two models that report it, and the two are not comparable.
  it('describes a probability scale for the model that reports one', async () => {
    const wrapper = await render();
    await wrapper.find('#transcribe-model').setValue(NOVA.id);

    expect(wrapper.text()).toMatch(/confidence score between 0 and 1/iu);
  });

  it('warns that a log probability is not a percentage', async () => {
    expect((await render()).text()).toMatch(/cannot be read as a percentage/iu);
  });

  it('says plainly when a model reports no quality figures at all', async () => {
    const wrapper = await render();
    await wrapper.find('#transcribe-model').setValue(SMALL.id);

    expect(wrapper.text()).toMatch(/no confidence or quality figures/iu);
  });
});

describe('the submit control', () => {
  it('is disabled until audio is loaded', async () => {
    expect((await render()).find('.transcribe-button').attributes('disabled')).toBeDefined();
  });

  // Before any audio is chosen there is no output column at all — a half-width empty panel reads
  // as something failing to load. The placeholder appears once there is a reason to split the
  // layout, which is the moment a visitor starts looking for the result.
  it('shows no output column before audio is chosen', async () => {
    expect((await render()).find('.placeholder').exists()).toBe(false);
  });

  it('names the accepted formats and the limit in force', async () => {
    const text = (await render()).text();

    expect(text).toMatch(/MP3, WAV, Ogg, WebM, or MP4/u);
    expect(text).toMatch(/up to 4\.0 MB for the selected model/u);
  });
});
