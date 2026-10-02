import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import { useHandoffStore } from '../../../src/client/stores/handoff';
import DescribeImageView from '../../../src/client/views/DescribeImageView.vue';
import type { ImageMediaType } from '../../../src/shared/images';
import {
  clickTeleported,
  isDialogOpen,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

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
 * Mounts the view with a pre-populated catalogue.
 *
 * @param models Models to offer.
 * @param handoff Picture to stage as a pending handoff, if any.
 * @returns The mounted wrapper.
 */
async function mountView(
  models: CatalogueModel[] = [CAPTIONS_ALONE, REQUIRES_QUESTION],
  handoff?: { base64: string; mediaType: ImageMediaType; byteLength: number; origin: string }
) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.models = models;
  catalogue.loaded = true;

  if (handoff !== undefined) {
    useHandoffStore(pinia).offer(handoff);
  }

  const wrapper = mount(DescribeImageView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });

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

describe('DescribeImageView', () => {
  // Teleported into the shell's header bar, so it is read from the document rather than from the
  // component's own subtree.
  it('shows the panel name in the header', async () => {
    expect(panelText(await mountView())).toContain('Describe Image');
  });

  it('offers every reviewed model in the selector', async () => {
    const options = (await mountView()).findAll('#vision-model option');
    expect(options).toHaveLength(2);
  });

  it('offers a prepared question for each example', async () => {
    const wrapper = await mountView();
    expect(wrapper.findAll('[data-example]').length).toBeGreaterThanOrEqual(4);
  });

  it('loads an example into the question field', async () => {
    const wrapper = await mountView();
    await wrapper.find('[data-example="alt-text"]').trigger('click');

    const field = wrapper.find('#vision-instruction').element as HTMLTextAreaElement;
    expect(field.value).toContain('alt text');
  });

  it('links to the selected model\u2019s catalog page', async () => {
    const link = (await mountView()).find('.docs-link a');
    expect(link.attributes('href')).toBe(CAPTIONS_ALONE.documentationUrl);
  });
});

describe('the disclosure', () => {
  // Tells the visitor to assume their upload is logged, rather than promising it is not. Payload
  // retention is AI Gateway's behaviour, so a reassurance here would be a claim this application
  // cannot keep on a visitor's behalf.
  it('warns that the picture and question should be assumed logged', async () => {
    await mountView();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your picture and question are logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  it('makes no promise that the picture is unretained', async () => {
    const wrapper = await mountView();
    await clickTeleported('.about-button');

    const text = panelText(wrapper);
    expect(text).not.toMatch(/not stored/iu);
    expect(text).not.toMatch(/not retained/iu);
  });

  // This panel has something extra to disclose: the visitor is uploading a picture, which may
  // carry faces, documents, or location data they have not thought about.
  // Previously this compared the position of the warning against the position of the dropzone in
  // the rendered HTML. The disclosure now lives in a modal teleported to the body, so the warning
  // is not in this subtree at all and `indexOf` returned -1 — which is less than any real index,
  // so the old assertion passed without testing anything.
  //
  // What matters for this panel is unchanged and is what is asserted instead: the warning is
  // reachable from the moment the panel loads, before a visitor has chosen a picture that might
  // contain faces, documents, or location data they have not thought about.
  it('offers the warning before any picture has been chosen', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.preview').exists()).toBe(false);

    await clickTeleported('.about-button');
    expect(openDialogText()).toMatch(/assume your picture and question are logged/iu);
  });

  it('states that the verified email is recorded for attribution', async () => {
    await mountView();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/verified email is recorded/iu);
  });
});

describe('the model contract difference', () => {
  it('marks the question optional for a model that captions alone', async () => {
    expect((await mountView()).text()).toContain('optional for this model');
  });

  it('marks the question required once a demanding model is selected', async () => {
    const wrapper = await mountView();
    await wrapper.find('#vision-model').setValue(REQUIRES_QUESTION.id);

    expect(wrapper.text()).toContain('required for this model');
  });

  // The honest explanation for why the form changes. Without it, a visitor who switches models
  // and finds the button disabled would reasonably think the page had broken.
  it('explains the selected model\u2019s expectations in prose', async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain('will caption a picture on its own');

    await wrapper.find('#vision-model').setValue(REQUIRES_QUESTION.id);
    expect(wrapper.text()).toContain('requires a question');
  });

  it('renders the answer-length control the model declares', async () => {
    expect((await mountView()).find('#vision-max-tokens').exists()).toBe(true);
  });

  it('omits a control the model does not declare', async () => {
    const withoutControls: CatalogueModel = {
      ...CAPTIONS_ALONE,
      visionControls: { instructionRequired: false }
    };
    expect((await mountView([withoutControls])).find('#vision-max-tokens').exists()).toBe(false);
  });
});

describe('before a picture is chosen', () => {
  it('invites the visitor to choose one', async () => {
    expect((await mountView()).text()).toContain('Choose a picture to describe');
  });

  it('disables the Describe button', async () => {
    const button = (await mountView()).find('.describe-button');
    expect(button.attributes('disabled')).toBeDefined();
  });

  it('offers all three ways of supplying a picture', async () => {
    const text = (await mountView()).text();
    expect(text).toMatch(/drop a picture/iu);
    expect(text).toMatch(/paste/iu);
    expect(text).toMatch(/choose a file/iu);
  });

  it('names the accepted formats', async () => {
    expect((await mountView()).text()).toContain('PNG, JPEG, or WebP');
  });
});

describe('a picture handed over from Create Image', () => {
  it('is collected on mount and previewed', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image (Rich Model)'
    });

    expect(wrapper.find('.preview').attributes('src')).toBe('data:image/png;base64,AAAA');
  });

  it('states where the picture came from, since it has no file name', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image (Rich Model)'
    });

    expect(wrapper.text()).toContain('Generated in Create Image');
  });

  it('enables the Describe button straight away', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image'
    });

    expect(wrapper.find('.describe-button').attributes('disabled')).toBeUndefined();
  });

  // The alt text says what the picture *is to this panel* rather than describing its contents.
  // Nothing has looked at it yet — that is the entire point of the panel — so claiming to
  // describe it would be a fabrication aimed at the one user who cannot check.
  it('gives the preview honest alt text', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image'
    });

    expect(wrapper.find('.preview').attributes('alt')).toBe('Picture to describe preview');
  });
});

describe('accessibility', () => {
  it('labels the question field', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('label[for="vision-instruction"]').exists()).toBe(true);
  });

  it('labels the model selector', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('label[for="vision-model"]').exists()).toBe(true);
  });

  it('gives every section an accessible name', async () => {
    const wrapper = await mountView();
    for (const section of wrapper.findAll('section')) {
      expect(section.attributes('aria-labelledby')).toBeDefined();
    }
  });

  // Visible but deliberately not live: announcing every count change masks the run status.
  it('keeps the character counter out of the live regions', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.counter').attributes('aria-live')).toBeUndefined();
  });

  // The file input is visually hidden and has no visible label of its own, so without an
  // explicit one it reaches the accessibility tree as an unnamed file control. Caught by
  // inspecting the running page rather than by any offline assertion, which is why the guard
  // exists now.
  it('names the hidden file input', async () => {
    const input = (await mountView()).find('input[type="file"]');
    expect(input.attributes('aria-label')).toBeTruthy();
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
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 10,
      origin: 'Generated in Create Image'
    });

    for (const image of wrapper.findAll('img')) {
      expect(image.attributes('alt')).toBeTruthy();
    }
  });
});

describe('the reorganised layout', () => {
  // The panels were previously five stacked sections of equal weight, which put the input below
  // the description and the result below everything. These tests pin the new arrangement: input
  // first, settings collapsed beneath it, output beside it.
  it('puts the input ahead of the model settings', async () => {
    const wrapper = await mountView();
    const composer = wrapper.find('.composer').element;
    const settings = wrapper.find('details').element;

    const relation = composer.compareDocumentPosition(settings);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Collapsed, with the selected model named in the summary. The settings were the third of five
  // equally-weighted blocks and most of a visit does not touch them.
  it('collapses the model settings but names the selected model', async () => {
    const wrapper = await mountView();
    const details = wrapper.find('details');

    expect(details.element.open).toBe(false);
    expect(details.find('summary').text()).toContain(CAPTIONS_ALONE.name);
  });

  it('still allows the settings to be opened and edited', async () => {
    const wrapper = await mountView();
    await wrapper.find('summary').trigger('click');

    expect(wrapper.find('details').element.open).toBe(true);
    expect(wrapper.find('#vision-model').exists()).toBe(true);
  });

  // A half-width column of empty space beside the input reads as something failing to load, so
  // the second column appears only once there is something to put in it.
  it('stays a single column until a picture is chosen', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.workspace').classes()).not.toContain('workspace--split');
  });

  // As soon as a picture arrives, not merely once an answer does: the preview is worth a column
  // of its own, and switching the layout on completion would move the input mid-run.
  it('splits into two columns once a picture is present', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image'
    });

    expect(wrapper.find('.workspace').classes()).toContain('workspace--split');
  });

  it('labels the output column even before an answer arrives', async () => {
    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image'
    });

    expect(wrapper.find('.workspace-output').text()).toContain('Run output');
  });

  // The run details were the last of five blocks, which put a run's reported cost — one of the
  // things this demo exists to show — furthest from the answer it described. There is no run yet
  // here, so there is nothing for the button to describe.
  it('offers no run-details button before a run', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.run-details-button').exists()).toBe(false);
  });
});

describe('the run-details modal', () => {
  /**
   * Runs one description against a stubbed endpoint and returns the mounted panel.
   *
   * Drives the real composable over a stubbed `fetch` rather than injecting a fake result, because
   * what is being tested is the wiring between a completed run and the modal that reports its cost
   * — and injecting the receipt would skip exactly that wiring.
   *
   * @returns The mounted wrapper, after the run has completed.
   */
  async function runOnce() {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/metrics')
                ? { runId: 'run-1', costStatus: 'available', totalCostUsd: 0.000_42, requests: [] }
                : {
                    description: 'A red door.',
                    image: {
                      mediaType: 'image/png',
                      byteLength: 2_048,
                      width: 120,
                      height: 80
                    },
                    receipt: {
                      runId: 'run-1',
                      task: 'describe-image',
                      model: CAPTIONS_ALONE.id,
                      gatewayRouted: true,
                      logIds: ['log-abc'],
                      status: 'completed',
                      costStatus: 'pending',
                      elapsedMs: 412,
                      startedAt: '2026-04-01T09:15:00.000Z'
                    },
                    applied: { model: CAPTIONS_ALONE.id, maxTokens: 512 }
                  }
            ),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      )
    );

    const wrapper = await mountView(undefined, {
      base64: 'AAAA',
      mediaType: 'image/png',
      byteLength: 2_048,
      origin: 'Generated in Create Image'
    });

    await wrapper.find('.describe-button').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('shows the description in the output column', async () => {
    const wrapper = await runOnce();
    expect(wrapper.find('.workspace-output').text()).toContain('A red door.');
  });

  it('offers a run-details button once a run has completed', async () => {
    const wrapper = await runOnce();
    expect(wrapper.find('.run-details-button').exists()).toBe(true);
  });

  // The details are beside the answer they describe rather than at the bottom of the page, but
  // they are still only shown on request — a cost table is reference material, not the result.
  it('keeps the details closed until asked', async () => {
    await runOnce();
    expect(isDialogOpen()).toBe(false);
  });

  it('reports the run and its cost when opened', async () => {
    const wrapper = await runOnce();
    await wrapper.find('.run-details-button').trigger('click');

    const text = openDialogText();
    expect(text).toContain('Run details');
    expect(text).toContain(CAPTIONS_ALONE.id);
    expect(text).toMatch(/\$0\.000420/u);
  });

  // The gateway log identifier is the only thread between this panel and the AI Gateway
  // dashboard, so it has to survive the move into the modal.
  it('names the gateway log in the details', async () => {
    const wrapper = await runOnce();
    await wrapper.find('.run-details-button').trigger('click');

    expect(openDialogText()).toContain('log-abc');
  });
});
