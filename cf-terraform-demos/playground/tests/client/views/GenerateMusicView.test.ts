/**
 * @file Tests for the Generate Music view. Most of what is asserted here is **copy**, which is
 *   unusual for a view test and is the right emphasis for this panel: the controls are ordinary
 *   selects and text areas, while the sentences around them are the panel's entire teaching value.
 *   A cost figure shown without its unit, or a missing control shown without an explanation, would
 *   leave the panel working and pointless. The per-track and per-second cost labels are asserted
 *   against both models from one mount, so a regression that rendered one sentence for both billing
 *   models fails here rather than being discovered by a reader of the deployed panel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import GenerateMusicView from '../../../src/client/views/GenerateMusicView.vue';
import type { GenerateMusicResponse } from '../../../src/shared/generate-music';
import {
  clickTeleported,
  createPanelTitleTarget,
  isDialogOpen,
  openDialogText,
  panelStubs
} from '../support/panel';

/**
 * A per-second model with a length control and no lyrics field, matching ElevenLabs Music v2.
 */
const PER_SECOND: CatalogueModel = {
  id: 'test/music-seconds',
  name: 'Test Per-Second',
  provider: 'third-party',
  task: 'generate-music',
  pricingUnit: 'audio-second',
  documentationUrl: 'https://example.invalid/per-second',
  musicControls: {
    instrumentalParameterName: 'force_instrumental',
    instrumentalParameterRequired: false,
    lyrics: 'unsupported',
    lengthParameterName: 'music_length_ms',
    lengthUnit: 'milliseconds',
    lengthSeconds: { min: 3, max: 120, step: 1, default: 15 },
    formatParameterName: 'output_format',
    formats: ['mp3_44100_128', 'mp3_44100_192'],
    defaultFormat: 'mp3_44100_128',
    seed: true,
    pricing: { unit: 'audio-second', pricePerOutputSecondUsd: 0.0025 },
    outputHosts: ['examples.aig.cloudflare.com']
  }
};

/**
 * A per-track model with no length control and lyrics support, matching MiniMax Music 2.6.
 */
const PER_TRACK: CatalogueModel = {
  id: 'test/music-track',
  name: 'Test Per-Track',
  provider: 'third-party',
  task: 'generate-music',
  pricingUnit: 'track',
  documentationUrl: 'https://example.invalid/per-track',
  musicControls: {
    instrumentalParameterName: 'is_instrumental',
    instrumentalParameterRequired: true,
    lyrics: 'optional',
    lyricsParameterName: 'lyrics',
    lyricsOptimizerParameterName: 'lyrics_optimizer',
    lyricsOptimizerRequired: true,
    requiresLyricsForVocals: true,
    formatParameterName: 'format',
    formats: ['mp3', 'wav'],
    defaultFormat: 'mp3',
    seed: false,
    pricing: { unit: 'track', pricePerTrackUsd: 0.15, pricePerLyricsGenerationUsd: 0.01 },
    outputHosts: ['tracks.example.invalid']
  }
};

/**
 * A successful run, as the endpoint returns it.
 */
const RESULT: GenerateMusicResponse = {
  track: {
    base64: 'SUQzAwA=',
    mediaType: 'audio/mpeg',
    byteLength: 2_048,
    sourceHost: 'examples.aig.cloudflare.com'
  },
  receipt: {
    runId: 'run-1',
    task: 'generate-music',
    model: PER_SECOND.id,
    gatewayRouted: true,
    logIds: ['log-1'],
    status: 'completed',
    costStatus: 'available',
    elapsedMs: 18_000,
    startedAt: new Date().toISOString()
  },
  applied: {
    model: PER_SECOND.id,
    prompt: 'ambient piano',
    instrumental: true,
    lyricsSource: 'none',
    lengthSeconds: 15,
    format: 'mp3_44100_128',
    pricingUnit: 'audio-second',
    estimatedCostUsd: 0.0375,
    costBasis: '$0.0025 per second of output audio \u00d7 15 seconds.'
  }
};

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [PER_SECOND, PER_TRACK]) {
  createPanelTitleTarget();

  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(GenerateMusicView, {
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
  // Required of every inference panel by `tests/client/privacy-claims.test.ts`. Asserted here too so
  // a reworded disclosure fails in the panel's own test rather than only in the global guard.
  it('warns that the prompt is logged and advises against confidential input', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your prompt and any lyrics are logged/iu);
    expect(text).toMatch(/nothing confidential|anything confidential/iu);
  });

  // The reason this phase sits after every credit-free panel. Stating it is part of the panel's
  // teaching value, not incidental — and it is the explanation a visitor needs for a `503`.
  it('states that every model is third-party and spends prepaid credit', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/prepaid AI Gateway credits/iu);
    expect(text).toMatch(/no music model at all/iu);
  });

  // The panel's central lesson, in the panel's own words.
  it('explains that the charges are not per-token and are not comparable', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/per second of output audio/iu);
    expect(text).toMatch(/per track/iu);
    expect(text).toMatch(/neither is billed per token/iu);
    expect(text).toMatch(/session cost meter/iu);
  });

  // The provider-hosted asset disclosure. It has to say both halves: the original may expire, and
  // what is on screen was fetched and checked server-side so the visitor's browser never talked to
  // the provider.
  it('discloses that the provider\u2019s own link is short-lived', async () => {
    await render();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/short-lived/iu);
    expect(text).toMatch(/approved host/iu);
    expect(text).toMatch(/never talks to the provider/iu);
  });

  // No retention promise this demo would have to keep. Nothing is stored, and the panel says that
  // rather than implying a result is durable.
  it('promises no retention', async () => {
    await render();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/nothing is kept here after you leave/iu);
  });
});

describe('the cost estimate', () => {
  // The per-second label, which moves with the length control.
  it('quotes a per-second estimate and names the unit', async () => {
    const wrapper = await render();

    const text = wrapper.text();
    expect(text).toMatch(/Estimated cost/iu);
    expect(text).toMatch(/billed per second of output audio/iu);
    // 15 seconds at $0.0025, the model's declared default.
    expect(text).toContain('$0.0375');
  });

  it('updates the per-second estimate when the length changes', async () => {
    const wrapper = await render();
    await wrapper.find('#music-length').setValue('60');

    expect(wrapper.text()).toContain('$0.1500');
  });

  // The per-track label from the same mount, which is what catches one sentence having been rendered
  // for both billing models.
  it('quotes a per-track estimate and names the different unit', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toMatch(/billed per track/iu);
    expect(text).toContain('$0.1500');
    expect(text).not.toMatch(/billed per second of output audio/iu);
  });

  it('adds the separate lyrics charge to the per-track estimate', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    await wrapper.find('#music-instrumental').setValue(false);
    await wrapper.find('#music-generate-lyrics').setValue(true);
    await flushPromises();

    expect(wrapper.text()).toContain('$0.1600');
  });

  // The basis sentence is where the arithmetic is explained, and where the panel says plainly that
  // this is not a token charge.
  it('explains the basis and denies that it is a token charge', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toMatch(/not by tokens/iu);
  });

  it('labels the figure an estimate and names the authoritative source', async () => {
    const wrapper = await render();
    const text = wrapper.text();

    expect(text).toMatch(/this is an estimate/iu);
    expect(text).toMatch(/AI Gateway log and is the authoritative one/iu);
  });
});

describe('controls that change with the model', () => {
  it('offers a length control for the model that has one', async () => {
    const wrapper = await render();

    expect(wrapper.find('#music-length').exists()).toBe(true);
    expect(wrapper.text()).toMatch(/also the price control/iu);
  });

  // The honest version of a missing control. A visitor who finds no length selector should learn
  // that the model has no length parameter rather than wondering whether the page failed.
  it('explains the absence of a length control rather than leaving a gap', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    expect(wrapper.find('#music-length').exists()).toBe(false);
    const text = wrapper.text();
    expect(text).toMatch(/no length parameter at all/iu);
    expect(text).toMatch(/would be rejected/iu);
  });

  it('offers lyrics controls only for the model that accepts them', async () => {
    const wrapper = await render();
    expect(wrapper.find('#music-generate-lyrics').exists()).toBe(false);
    expect(wrapper.text()).toMatch(/has no lyrics parameter/iu);

    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();
    expect(wrapper.find('#music-generate-lyrics').exists()).toBe(true);
    expect(wrapper.text()).toMatch(/will not sing without words/iu);
  });

  it('shows the lyrics editor only for a vocal track whose words the visitor writes', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    // Instrumental by default, so there is nothing to write.
    expect(wrapper.find('#music-lyrics').exists()).toBe(false);

    await wrapper.find('#music-instrumental').setValue(false);
    await flushPromises();
    expect(wrapper.find('#music-lyrics').exists()).toBe(true);

    // Asking the model to write them removes the editor, because supplying both is refused.
    await wrapper.find('#music-generate-lyrics').setValue(true);
    await flushPromises();
    expect(wrapper.find('#music-lyrics').exists()).toBe(false);
  });

  it('offers a seed only for the model that accepts one', async () => {
    const wrapper = await render();
    expect(wrapper.find('#music-seed').exists()).toBe(true);

    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();
    expect(wrapper.find('#music-seed').exists()).toBe(false);
  });

  // The format lists share no value, which the panel states so a visitor is not surprised that
  // their choice vanished on switching model.
  it('offers each model\u2019s own format names and says they are not shared', async () => {
    const wrapper = await render();
    expect(wrapper.findAll('#music-format option').map((option) => option.text())).toContain(
      'mp3_44100_128'
    );
    expect(wrapper.text()).toMatch(/share none of them/iu);

    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();
    expect(wrapper.findAll('#music-format option').map((option) => option.text())).toContain('wav');
  });
});

describe('submitting the panel', () => {
  it('disables the button and says why before a prompt is written', async () => {
    const wrapper = await render();

    expect(wrapper.find('.generate-button').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toMatch(/describe the music you want/iu);
  });

  it('enables the button once a prompt exists', async () => {
    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');

    expect(wrapper.find('.generate-button').attributes('disabled')).toBeUndefined();
  });

  // The provider refusal a visitor would not otherwise understand, surfaced before anything is
  // spent. On the per-track model that is the difference between a free refusal and fifteen cents.
  it('explains the no-words refusal before the request is made', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    await wrapper.find('#music-prompt').setValue('folk ballad');
    await wrapper.find('#music-instrumental').setValue(false);
    await flushPromises();

    expect(wrapper.find('.generate-button').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toMatch(/will not sing without words/iu);
  });

  it('renders the track, the applied settings, and the expiry note after a run', async () => {
    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');
    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('audio').exists()).toBe(true);
    const text = wrapper.text();
    expect(text).toContain('Instrumental');
    // The unit is named beside the result, not only in the run-details modal.
    expect(text).toMatch(/Per second of audio/iu);
    expect(text).toContain('$0.0375');
    // The expiry disclosure names the host, which is what keeps it concrete.
    expect(text).toContain('examples.aig.cloudflare.com');
    expect(text).toMatch(/may already have expired/iu);
  });

  it('says that stopping the wait does not stop the charge', async () => {
    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');

    // Held open so the in-flight copy is rendered.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );

    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toMatch(/takes noticeably longer/iu);
    expect(text).toMatch(/will still be charged for/iu);
    expect(wrapper.find('.cancel-button').exists()).toBe(true);
  });
});

describe('the prepared prompts', () => {
  it('offers prompts without running them', async () => {
    const wrapper = await render();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await wrapper.find('[data-example="ambient"]').trigger('click');

    expect((wrapper.find('#music-prompt').element as HTMLTextAreaElement).value).toMatch(
      /ambient/iu
    );
    // Loading a prompt that spent prepaid credit the moment it was clicked would be a trap.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('states that each prompt costs money and picks a short length', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toMatch(/every click here spends prepaid credit/iu);
  });

  // The vague prompt exists to be compared against a specific one, which the panel says rather than
  // leaving it looking like a poor example.
  it('includes a deliberately vague prompt for comparison', async () => {
    const wrapper = await render();
    const vague = wrapper.find('[data-example="vague"]');

    expect(vague.exists()).toBe(true);
    expect(vague.attributes('title')).toMatch(/comparison/iu);
  });

  it('loads an example\u2019s lyrics only for a model that accepts them', async () => {
    const wrapper = await render();
    await wrapper.find('#music-model').setValue(PER_TRACK.id);
    await flushPromises();

    await wrapper.find('[data-example="with-lyrics"]').trigger('click');
    await flushPromises();

    expect((wrapper.find('#music-lyrics').element as HTMLTextAreaElement).value).toMatch(
      /quiet road/iu
    );
  });
});

describe('the credit failure', () => {
  // Presented as the actionable thing it is rather than as one more red box inviting a retry that
  // cannot succeed. This is the first thing an unfunded account sees on this panel.
  it('renders its own notice with a link, not a generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 503,
              title: 'AI Gateway credits are unavailable',
              detail: 'Add AI Gateway credits, then try again.'
            }),
            { status: 503, headers: { 'content-type': 'application/problem+json' } }
          )
      )
    );

    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');
    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();

    const notice = wrapper.find('.credit-notice');
    expect(notice.exists()).toBe(true);
    expect(notice.attributes('role')).toBe('alert');
    expect(notice.text()).toMatch(/add credit/iu);
    expect(notice.text()).toMatch(/nothing was charged/iu);
    expect(wrapper.find('.credit-notice a').attributes('href')).toContain('unified-billing');
    // No generic error box beside it: one failure, one presentation.
    expect(wrapper.find('.error').exists()).toBe(false);
  });

  it('renders a provider failure as an ordinary error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 502, detail: 'The provider failed.' }), {
            status: 502,
            headers: { 'content-type': 'application/problem+json' }
          })
      )
    );

    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');
    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.credit-notice').exists()).toBe(false);
    expect(wrapper.find('.error').text()).toContain('The provider failed.');
  });
});

describe('run details', () => {
  it('opens the run-details modal after a run', async () => {
    const wrapper = await render();
    await wrapper.find('#music-prompt').setValue('ambient piano');
    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();

    expect(isDialogOpen()).toBe(false);
    // Inside the component's own subtree, unlike the About button in the shell header, so it is
    // clicked through the wrapper rather than through the teleport helper.
    await wrapper.find('.run-details-button').trigger('click');

    expect(isDialogOpen()).toBe(true);
    expect(openDialogText()).toMatch(/Reported cost/iu);
  });
});
