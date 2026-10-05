/**
 * @file Tests for the Animate Image view. The first group is the one the phase most needs: it pins
 *   that **Animate Image is a top-level panel with its own route and title, not a mode inside
 *   Create Video**. That is a structural promise rather than a styling one, and the way it would be
 *   broken — someone adding a mode switch to Create Video and deleting this route — is exactly the
 *   kind of change that looks like a simplification while discarding the decision. The rest is
 *   mostly **copy**, which is the right emphasis for this panel: the controls are ordinary selects,
 *   while the sentences around them carry the teaching value. The two pricing sentences are
 *   asserted against both models from one mount, so a regression that rendered one cost sentence
 *   for both billing shapes fails here rather than being found by a reader of the deployed panel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { buildRoutes } from '../../../src/client/router';
import { useCatalogueStore, type CatalogueModel } from '../../../src/client/stores/catalogue';
import AnimateImageView from '../../../src/client/views/AnimateImageView.vue';
import CreateVideoView from '../../../src/client/views/CreateVideoView.vue';
import { VIDEO_RETENTION_HOURS } from '../../../src/shared/create-video';
import { findTask, TASK_DESCRIPTORS } from '../../../src/shared/tasks';
import {
  clickTeleported,
  createPanelTitleTarget,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

/**
 * A per-second model with a duration range and an optional prompt, matching HappyHorse 1.1 I2V.
 */
const PER_SECOND: CatalogueModel = {
  id: 'test/animate-seconds',
  name: 'Test Per-Second',
  provider: 'third-party',
  task: 'animate-image',
  pricingUnit: 'video-second',
  documentationUrl: 'https://example.invalid/per-second',
  animateImageControls: {
    imageParameterName: 'image',
    imageDelivery: 'data-uri',
    motionPromptRequired: false,
    resolutions: ['720P', '1080P'],
    defaultResolution: '720P',
    durationRange: { min: 3, max: 15, step: 1, default: 5 },
    defaultDuration: 5,
    seed: true,
    negativePrompt: true,
    pricePerSecondUsd: { '720P': 0.14, '1080P': 0.18 },
    outputHosts: ['examples.aig.cloudflare.com']
  }
};

/**
 * A per-combination model with fixed durations and a required prompt, matching Hailuo 2.3. Its
 * price table deliberately omits one combination, which the panel has to report honestly.
 */
const PER_COMBINATION: CatalogueModel = {
  id: 'test/animate-combination',
  name: 'Test Per-Combination',
  provider: 'third-party',
  task: 'animate-image',
  pricingUnit: 'video-second',
  documentationUrl: 'https://example.invalid/per-combination',
  animateImageControls: {
    imageParameterName: 'first_frame_image',
    imageDelivery: 'data-uri',
    motionPromptRequired: true,
    resolutions: ['768P', '1080P'],
    defaultResolution: '768P',
    durationChoices: [6, 10],
    defaultDuration: 6,
    seed: false,
    negativePrompt: false,
    priceByCombinationUsd: { '768P@6': 0.28, '768P@10': 0.56, '1080P@6': 0.49 },
    outputHosts: ['video-product.cdn.minimax.io']
  }
};

/**
 * Mounts the view with a stubbed catalogue.
 *
 * @param models Models the catalogue should report.
 * @returns The mounted wrapper.
 */
async function render(models: CatalogueModel[] = [PER_SECOND, PER_COMBINATION]) {
  createPanelTitleTarget();

  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  // Stubbed rather than fetched: these tests are about what the panel renders from the catalogue,
  // not about loading it.
  catalogue.load = vi.fn(async () => undefined);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(AnimateImageView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'run-1' });
});

describe('Animate Image is its own panel, not a Create Video mode', () => {
  // The structural promise of the phase. The two panels share their implementation underneath and
  // nothing in the route table, so a visitor arriving with a picture finds a destination named for
  // what they want to do.
  it('has its own top-level route bound to its own view', () => {
    const route = buildRoutes().find((candidate) => candidate.path === '/animate-image');

    expect(route).toBeDefined();
    expect(route?.component).toBe(AnimateImageView);
    expect(route?.component).not.toBe(CreateVideoView);
  });

  it('is a sibling of Create Video rather than nested beneath it', () => {
    const routes = buildRoutes();
    const animate = routes.find((candidate) => candidate.path === '/animate-image');
    const createVideo = routes.find((candidate) => candidate.path === '/create-video');

    // Neither may own the other: a child route would be a panel reachable only through another,
    // which is the "studio with tabs" shape this product rejected.
    expect(animate?.children).toBeUndefined();
    expect(createVideo?.children).toBeUndefined();
    expect(animate?.path.startsWith('/create-video')).toBe(false);
  });

  it('is a catalogue panel in its own right, with its own name and task type', () => {
    const task = findTask('animate-image');

    expect(task?.name).toBe('Animate Image');
    expect(task?.taskType).toBe('Image to video');
    // Third-party only: this panel cannot be demonstrated without prepaid AI credits, which is
    // what the sidebar's lone 3P mark is there to say before a visitor tries it.
    expect(task?.hosting).toEqual({ cloudflare: false, thirdParty: true });
    // Distinct from Create Video's, so the sidebar and the document title can tell them apart.
    expect(task?.name).not.toBe(findTask('create-video')?.name);
  });

  it('renders its own panel title rather than Create Video\u2019s', async () => {
    // Read through `panelText`, because the title teleports into the shell's header bar rather
    // than rendering inside the panel's own subtree.
    const text = panelText(await render());

    expect(text).toContain('Animate Image');
    expect(text).not.toContain('Create Video');
  });

  // The way the decision would actually be undone: a mode selector appearing inside either panel.
  it('offers no mode switch between generating and animating', async () => {
    const wrapper = await render();
    const text = wrapper.text().toLowerCase();

    expect(text).not.toContain('text to video');
    expect(text).not.toContain('switch mode');

    // No control in the panel chooses between the two tasks; the model selector chooses a model.
    const selectIds = wrapper.findAll('select').map((element) => element.attributes('id'));
    expect(selectIds).not.toContain('animate-mode');
    for (const id of selectIds) {
      expect(id).toMatch(/^animate-(?:model|resolution|duration)$/u);
    }
  });

  it('keeps every panel route one level deep', () => {
    // Asserted across the whole table from this test too, because the temptation to nest arrives
    // with the second panel that shares an implementation.
    for (const task of TASK_DESCRIPTORS) {
      const route = buildRoutes().find((candidate) => candidate.path === `/${task.id}`);
      expect(route?.children, `${task.name} must not nest routes`).toBeUndefined();
    }
  });
});

describe('the panel\u2019s disclosures', () => {
  /**
   * Opens the panel's "about" dialog, where the disclosures live.
   *
   * They sit behind the header's info button rather than above the controls, matching every other
   * panel — so a test asserting on them has to open it rather than reading the form.
   *
   * @returns The dialog's text, whitespace-collapsed.
   */
  async function disclosures(): Promise<string> {
    await render();
    await clickTeleported('.about-button');
    return openDialogText();
  }

  it('states that no Cloudflare-hosted model exists for this task', async () => {
    // The reason every run here needs prepaid credit. Saying it up front makes a billing failure
    // read as a known limitation rather than as the demo being broken.
    expect(await disclosures()).toMatch(/no Cloudflare-hosted image-to-video model/iu);
  });

  it('warns that the prompt and the picture should be assumed logged', async () => {
    const text = await disclosures();

    expect(text).toMatch(/assume your motion prompt is logged/iu);
    expect(text).toMatch(/assume it is logged/iu);
  });

  // The demo makes no retention promise about data it does not control, and the picture reaches a
  // third-party provider. A reassurance a visitor might act on is worse than none.
  it('makes no claim that the picture is never stored', async () => {
    const text = await disclosures();

    expect(text).not.toMatch(/\b(?:is|are) not (?:stored|retained)\b/iu);
    expect(text).not.toMatch(/\bnever (?:stored|retained)\b/iu);
  });

  // Phase 8 asserted the opposite of this: that the panel promised *no* expiry, because nothing
  // enforced one and an unenforced countdown is a claim a visitor might act on. Phase 18 added
  // the scheduled reaper, so the honest wording is now the one that states the window — and the
  // assertion is inverted rather than deleted, because "says nothing about expiry" and "states
  // the enforced expiry" are both correct only at the right time.
  it('states the expiry the scheduled reaper now enforces', async () => {
    const text = await disclosures();

    expect(text).toMatch(/copied once into this demo's storage/iu);
    expect(text).toMatch(
      new RegExp(`deletes it ${VIDEO_RETENTION_HOURS} hours after it is stored`, 'iu')
    );
    // The phase 8 wording, which is now false.
    expect(text).not.toMatch(/nothing deletes it automatically yet/iu);
  });
});

describe('cost copy', () => {
  it('quotes a per-second estimate before any request', async () => {
    // The figure a visitor most needs sits beside the button that spends it, not behind a
    // disclosure.
    const text = (await render()).text();

    expect(text).toMatch(/Estimated cost/u);
    expect(text).toContain('$0.7000');
    expect(text).toMatch(/An estimate from the model's published prices/u);
  });

  it('quotes the exact published figure for a per-combination model', async () => {
    const wrapper = await render();

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    expect(wrapper.text()).toContain('$0.2800');
  });

  // The assertion that separates "free" from "nobody has said". A bare `$0.00` would make the
  // wrong one of those two claims.
  it('says there is no published price rather than showing a zero', async () => {
    const wrapper = await render();

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();
    await wrapper.find('#animate-resolution').setValue('1080P');
    await wrapper.find('#animate-duration').setValue('10');
    await flushPromises();

    const text = wrapper.text();
    expect(text).toMatch(/No published price/u);
    expect(text).toMatch(/This run will still be charged/u);
    expect(text).not.toContain('$0.0000');
  });
});

describe('model-driven controls', () => {
  it('marks the motion prompt optional or required to match the model', async () => {
    const wrapper = await render();

    expect(wrapper.text()).toMatch(/will animate the picture without one/u);

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    expect(wrapper.text()).toMatch(/requires this/u);
  });

  it('offers a negative prompt only for the model that accepts one', async () => {
    const wrapper = await render();
    expect(wrapper.find('#animate-negative-prompt').exists()).toBe(true);

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    expect(wrapper.find('#animate-negative-prompt').exists()).toBe(false);
  });

  it('lists each model\u2019s own resolutions and never the other\u2019s', async () => {
    const wrapper = await render();

    const first = wrapper.find('#animate-resolution').text();
    expect(first).toContain('720P');
    expect(first).not.toContain('768P');

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    const second = wrapper.find('#animate-resolution').text();
    expect(second).toContain('768P');
    expect(second).not.toContain('720P');
  });

  it('offers a duration range for one model and only the fixed lengths for the other', async () => {
    const wrapper = await render();

    // The range model offers every integer from 3 to 15, plus the default option.
    expect(wrapper.find('#animate-duration').findAll('option')).toHaveLength(14);

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    const fixed = wrapper.find('#animate-duration');
    expect(fixed.findAll('option')).toHaveLength(3);
    expect(fixed.text()).toContain('6 seconds');
    expect(fixed.text()).toContain('10 seconds');
    // Says why the choice is narrow, rather than leaving a visitor to wonder what happened to the
    // slider the other model had.
    expect(wrapper.text()).toMatch(/accepts only these lengths/u);
  });

  it('shows the per-second price against each resolution only where one exists', async () => {
    const wrapper = await render();
    expect(wrapper.find('#animate-resolution').text()).toContain('/second');

    await wrapper.find('#animate-model').setValue(PER_COMBINATION.id);
    await flushPromises();

    // A per-combination model has no per-second rate, so quoting one would be inventing it.
    expect(wrapper.find('#animate-resolution').text()).not.toContain('/second');
  });
});

describe('the panel before a run', () => {
  it('asks for a picture and cannot be submitted without one', async () => {
    const wrapper = await render();

    expect(wrapper.text()).toMatch(/Choose a picture to animate/u);
    expect(wrapper.find('.animate-button').attributes('disabled')).toBeDefined();
  });

  it('offers prepared instructions that describe motion rather than the picture', async () => {
    const wrapper = await render();

    const examples = wrapper.findAll('[data-example]');
    expect(examples.length).toBeGreaterThan(0);

    // The panel's own hint states the lesson the examples teach.
    expect(wrapper.text()).toMatch(/Describe the motion . not the picture/u);
  });

  it('loads a prepared instruction without starting a run', async () => {
    const wrapper = await render();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await wrapper.findAll('[data-example]')[0]?.trigger('click');
    await flushPromises();

    // An example that spent money the moment it was clicked would be a trap in a panel billing
    // per second of output.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((wrapper.find('#animate-motion-prompt').element as HTMLTextAreaElement).value).not.toBe(
      ''
    );
  });

  it('links to the selected model\u2019s catalogue page', async () => {
    const wrapper = await render();

    expect(wrapper.find('.docs-link a').attributes('href')).toBe(PER_SECOND.documentationUrl);
  });
});
