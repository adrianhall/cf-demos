import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import { useHandoffStore } from '../../../src/client/stores/handoff';
import ClassifyImageView from '../../../src/client/views/ClassifyImageView.vue';
import type { ImageMediaType } from '../../../src/shared/images';
import {
  clickTeleported,
  isDialogOpen,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

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
 * A picture staged as a pending handoff, so the panel has an image without a file-picker event.
 */
const HANDOFF: { base64: string; mediaType: ImageMediaType; byteLength: number; origin: string } = {
  base64: 'AAAA',
  mediaType: 'image/png',
  byteLength: 2_048,
  origin: 'Generated in Create Image'
};

/**
 * A successful classification, as the endpoint returns it.
 */
const RESULT = {
  labels: [
    { rank: 1, label: 'Egyptian cat', score: 0.523_1 },
    { rank: 2, label: 'tabby', score: 0.41 }
  ],
  totalLabels: 5,
  image: { mediaType: 'image/png', byteLength: 2_048, width: 120, height: 80 },
  receipt: {
    runId: 'run-1',
    task: 'classify-image',
    model: CLASSIFIER.id,
    gatewayRouted: true,
    logIds: ['log-abc'],
    status: 'completed',
    costStatus: 'pending',
    elapsedMs: 212,
    startedAt: '2026-04-01T09:15:00.000Z'
  },
  applied: { model: CLASSIFIER.id, topK: 5, minimumConfidence: 0 }
};

/**
 * Mounts the view with a pre-populated catalogue.
 *
 * @param models Models to offer.
 * @param handoff Picture to stage as a pending handoff, if any.
 * @returns The mounted wrapper.
 */
async function mountView(models: CatalogueModel[] = [CLASSIFIER], handoff?: typeof HANDOFF) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.models = models;
  catalogue.loaded = true;

  if (handoff !== undefined) {
    useHandoffStore(pinia).offer(handoff);
  }

  const wrapper = mount(ClassifyImageView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });

  await flushPromises();
  return wrapper;
}

/**
 * Runs one classification against a stubbed endpoint and returns the mounted panel.
 *
 * Drives the real composable over a stubbed `fetch` rather than injecting a result, because what is
 * being tested is the wiring between a completed run and what the panel renders.
 *
 * @param result Response body the classification endpoint should return.
 * @returns The mounted wrapper, after the run has completed.
 */
async function runOnce(result: unknown = RESULT) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/metrics')
              ? { runId: 'run-1', costStatus: 'available', totalCostUsd: 0.000_003, requests: [] }
              : result
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
  );

  const wrapper = await mountView([CLASSIFIER], HANDOFF);
  await wrapper.find('.classify-button').trigger('click');
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  // The store is pre-populated, so this only guards against a real network call.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('the view should not reach the network in a test');
    })
  );
});

describe('ClassifyImageView', () => {
  // Teleported into the shell's header bar, so it is read from the document rather than from the
  // component's own subtree.
  it('shows the panel name in the header', async () => {
    expect(panelText(await mountView())).toContain('Classify Image');
  });

  it('offers every reviewed model in the selector', async () => {
    expect((await mountView()).findAll('#classify-model option')).toHaveLength(1);
  });

  it('links to the selected model\u2019s catalog page', async () => {
    expect((await mountView()).find('.docs-link a').attributes('href')).toBe(
      CLASSIFIER.documentationUrl
    );
  });

  // The panel takes a picture and two numbers. A prompt field would imply the classifier can be
  // asked something, which it cannot.
  it('offers no prompt field, since a classifier takes none', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('textarea').exists()).toBe(false);
  });
});

describe('the disclosure', () => {
  it('warns that the picture should be assumed logged', async () => {
    await mountView();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your picture is logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  it('makes no promise that the picture is unretained', async () => {
    const wrapper = await mountView();
    await clickTeleported('.about-button');

    const text = panelText(wrapper);
    expect(text).not.toMatch(/not stored/iu);
    expect(text).not.toMatch(/not retained/iu);
  });

  // The thing this panel has to say that no earlier panel did. A confidence bar is extremely good
  // at implying a score is a probability of being correct, so the About dialog says plainly that
  // it is not.
  it('explains that a score is not a probability of being correct', async () => {
    await mountView();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/not a probability that the label is correct/iu);
    expect(text).toMatch(/fixed list of categories/iu);
  });
});

describe('the result controls', () => {
  it('renders both controls the model declares', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('#classify-top-k').exists()).toBe(true);
    expect(wrapper.find('#classify-minimum-confidence').exists()).toBe(true);
  });

  it('omits a control the model does not declare', async () => {
    const withoutFloor: CatalogueModel = {
      ...CLASSIFIER,
      classificationControls: { topK: { min: 1, max: 5, step: 1, default: 3 }, appliedBy: 'model' }
    };
    const wrapper = await mountView([withoutFloor]);
    expect(wrapper.find('#classify-minimum-confidence').exists()).toBe(false);
  });

  // The honest version of a slider. The reviewed classifier takes no ranking parameters, so a
  // control that implied the model was asked would misteach the one thing this panel demonstrates.
  it('says the controls are applied after the model answers', async () => {
    expect((await mountView()).text()).toContain('takes no ranking parameters');
  });

  it('says so differently for a model that applies them itself', async () => {
    const serverSide: CatalogueModel = {
      ...CLASSIFIER,
      classificationControls: { topK: { min: 1, max: 5, step: 1, default: 3 }, appliedBy: 'model' }
    };
    expect((await mountView([serverSide])).text()).toContain('applies these controls itself');
  });

  it('states that raising the floor does not improve the remaining labels', async () => {
    expect((await mountView()).text()).toMatch(/does not make the remaining labels any more/iu);
  });

  it('offers a prepared setting for each example', async () => {
    expect((await mountView()).findAll('[data-example]').length).toBeGreaterThanOrEqual(4);
  });

  it('loads an example into the controls', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-example="top-label"]').trigger('click');

    expect((wrapper.find('#classify-top-k').element as HTMLInputElement).value).toBe('1');
  });
});

describe('before a picture is chosen', () => {
  it('invites the visitor to choose one', async () => {
    expect((await mountView()).text()).toContain('Choose a picture to classify');
  });

  it('disables the Classify button', async () => {
    expect((await mountView()).find('.classify-button').attributes('disabled')).toBeDefined();
  });

  it('offers all three ways of supplying a picture', async () => {
    const text = (await mountView()).text();
    expect(text).toMatch(/drop a picture/iu);
    expect(text).toMatch(/paste/iu);
    expect(text).toMatch(/choose a file/iu);
  });

  it('stays a single column until a picture is chosen', async () => {
    expect((await mountView()).find('.workspace').classes()).not.toContain('workspace--split');
  });

  it('splits into two columns once a picture is present', async () => {
    const wrapper = await mountView([CLASSIFIER], HANDOFF);
    expect(wrapper.find('.workspace').classes()).toContain('workspace--split');
  });

  it('offers no run-details button before a run', async () => {
    expect((await mountView()).find('.run-details-button').exists()).toBe(false);
  });
});

describe('the ranked result', () => {
  it('renders one row per label', async () => {
    const wrapper = await runOnce();
    expect(wrapper.findAll('.ranked-labels tbody tr')).toHaveLength(2);
  });

  it('shows each label and its score as text', async () => {
    const text = (await runOnce()).find('.workspace-output').text();
    expect(text).toContain('Egyptian cat');
    expect(text).toContain('52.3%');
    expect(text).toContain('tabby');
    expect(text).toContain('41.0%');
  });

  // Phrased as "of the labels this model returned" rather than "top 2", because the model was not
  // asked for two — it scored five and the panel kept two.
  it('says how much of the model\u2019s answer is on screen', async () => {
    expect((await runOnce()).text()).toContain('Showing 2 of the 5 labels this model returned.');
  });

  // The caveat beside the result, for a visitor who never opens the About dialog.
  it('repeats the score caveat beside the ranking', async () => {
    expect((await runOnce()).find('.score-caveat').text()).toMatch(
      /not that the label is correct/iu
    );
  });

  it('offers the structured response as a closed disclosure', async () => {
    const details = (await runOnce()).find<HTMLDetailsElement>('details.structured');
    expect(details.exists()).toBe(true);
    expect(details.element.open).toBe(false);
  });

  // The disclosure shows what the model actually returned, so it carries the full-precision score
  // rather than the rounded percentage the table displays.
  it('shows the full-precision scores in the structured response', async () => {
    const wrapper = await runOnce();
    await wrapper.find('details.structured summary').trigger('click');

    expect(wrapper.find('.structured-json').text()).toContain('0.5231');
  });

  it('reports the controls that were applied', async () => {
    const text = (await runOnce()).find('.workspace-output').text();
    expect(text).toContain('Labels shown');
    expect(text).toContain('5');
  });
});

describe('an empty ranking', () => {
  // A successful run in which the visitor hid everything the model said. Collapsing this into
  // "no result yet" would make a raised threshold look like a broken panel.
  it('explains that the floor hid everything rather than showing nothing', async () => {
    const wrapper = await runOnce({ ...RESULT, labels: [], totalLabels: 5 });

    const text = wrapper.find('.workspace-output').text();
    expect(text).toContain('returned 5 labels');
    expect(text).toMatch(/lower the minimum score/iu);
  });

  it('renders no ranking table when nothing survived', async () => {
    const wrapper = await runOnce({ ...RESULT, labels: [], totalLabels: 5 });
    expect(wrapper.find('.ranked-labels').exists()).toBe(false);
  });

  // The run still happened and still cost something, so it still has details worth reading.
  it('still offers the run details', async () => {
    const wrapper = await runOnce({ ...RESULT, labels: [], totalLabels: 5 });
    expect(wrapper.find('.run-details-button').exists()).toBe(true);
  });
});

describe('the run-details modal', () => {
  it('offers a run-details button once a run has completed', async () => {
    expect((await runOnce()).find('.run-details-button').exists()).toBe(true);
  });

  it('keeps the details closed until asked', async () => {
    await runOnce();
    expect(isDialogOpen()).toBe(false);
  });

  it('reports the run and its cost when opened', async () => {
    const wrapper = await runOnce();
    await wrapper.find('.run-details-button').trigger('click');

    const text = openDialogText();
    expect(text).toContain('Run details');
    expect(text).toContain(CLASSIFIER.id);
  });

  // The gateway log identifier is the only thread between this panel and the AI Gateway
  // dashboard.
  it('names the gateway log in the details', async () => {
    const wrapper = await runOnce();
    await wrapper.find('.run-details-button').trigger('click');

    expect(openDialogText()).toContain('log-abc');
  });
});

describe('accessibility', () => {
  it('labels the model selector', async () => {
    expect((await mountView()).find('label[for="classify-model"]').exists()).toBe(true);
  });

  it('gives every section an accessible name', async () => {
    for (const section of (await mountView()).findAll('section')) {
      const named =
        section.attributes('aria-labelledby') !== undefined
        || section.attributes('aria-label') !== undefined;
      expect(named).toBe(true);
    }
  });

  it('gives every form control an accessible name', async () => {
    const wrapper = await mountView();

    for (const control of wrapper.findAll('input, select, textarea')) {
      const id = control.attributes('id');
      const named =
        control.attributes('aria-label') !== undefined
        || (id !== undefined && wrapper.find(`label[for="${id}"]`).exists());

      expect(named, `${control.element.tagName} ${id ?? '(no id)'} has a name`).toBe(true);
    }
  });

  it('never renders an image without alt text', async () => {
    const wrapper = await mountView([CLASSIFIER], HANDOFF);

    for (const image of wrapper.findAll('img')) {
      expect(image.attributes('alt')).toBeTruthy();
    }
  });

  // The specification's requirement for this panel. Every score is present as text and the bars
  // are hidden from assistive technology, so nothing is conveyed by bar length or colour alone.
  it('conveys every score as text rather than by bar alone', async () => {
    const wrapper = await runOnce();

    for (const bar of wrapper.findAll('.bar-track')) {
      expect(bar.attributes('aria-hidden')).toBe('true');
    }
    expect(wrapper.find('.ranked-labels').text()).toContain('52.3%');
  });

  // A real table, so a screen reader announces the row count and gives each score its label as
  // row context instead of reading a bare percentage.
  it('renders the ranking as a table with scoped headers', async () => {
    const wrapper = await runOnce();

    expect(wrapper.find('table.ranked-labels').exists()).toBe(true);
    expect(wrapper.findAll('thead th[scope="col"]')).toHaveLength(3);
    expect(wrapper.findAll('tbody th[scope="row"]')).toHaveLength(2);
  });

  it('announces the run status in a live region', async () => {
    expect((await mountView()).find('[role="status"]').exists()).toBe(true);
  });
});
