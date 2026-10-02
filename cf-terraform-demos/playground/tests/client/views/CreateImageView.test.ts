import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { IMAGE_EXAMPLES } from '../../../src/client/features/create-image/examples';
import { useCatalogueStore, type CatalogueModel } from '../../../src/client/stores/catalogue';
import CreateImageView from '../../../src/client/views/CreateImageView.vue';
import {
  clickTeleported,
  isDialogOpen,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

/**
 * A model exposing every control, mirroring Stable Diffusion XL.
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
 * A model exposing only steps, mirroring FLUX.1 [schnell].
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
 * Mounts the view with a pre-populated catalogue.
 *
 * @param models Models to offer, richest first by default.
 * @returns The mounted wrapper.
 */
async function mountView(models: CatalogueModel[] = [RICH, MINIMAL]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const catalogue = useCatalogueStore(pinia);
  catalogue.models = models;
  catalogue.loaded = true;

  const wrapper = mount(CreateImageView, {
    global: { plugins: [pinia], stubs: panelStubs() }
  });

  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  // The store is pre-populated, so this only guards against a real network call.
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [RICH, MINIMAL] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CreateImageView', () => {
  // The name is teleported into the shell's header bar and the task type now lives in the
  // description modal, so each is read from where it actually renders.
  it('shows the panel name in the header', async () => {
    expect(panelText(await mountView())).toContain('Create Image');
  });

  it('describes its technical task type in the panel description', async () => {
    await mountView();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Text to image');
  });

  it('declares that the panel is routed through AI Gateway', async () => {
    await mountView();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Routed through AI Gateway');
  });

  // The disclosure the whole attribution design depends on. It is behind the header's info button
  // rather than printed above the prompt, which is still before the visitor can spend anything —
  // but it has to be *reachable*, so the click is part of the assertion rather than assumed.
  it('discloses email attribution before the first request', async () => {
    await mountView();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/verified email is recorded in the AI Gateway log/iu);
  });

  // An image costs materially more per click than a short chat answer, so the warning says so.
  it('warns that an image costs more than a chat answer', async () => {
    await mountView();
    await clickTeleported('.about-button');

    expect(openDialogText()).toMatch(/more per request than a short chat answer/iu);
  });

  // Tells the visitor to assume their prompt is logged, rather than promising it is not. Payload
  // retention is AI Gateway's behaviour, the AI binding exposes no payload-collection option, and
  // the gateway documents that a log can include the prompt — so a reassurance here would be a
  // claim this application cannot keep on a visitor's behalf.
  it('warns that the prompt should be assumed logged', async () => {
    await mountView();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toMatch(/assume your prompt is logged/iu);
    expect(text).toMatch(/nothing confidential|anything confidential/iu);
  });

  it('makes no promise that the prompt or image is unretained', async () => {
    const wrapper = await mountView();
    await clickTeleported('.about-button');
    const text = panelText(wrapper);
    expect(text).not.toMatch(/not stored/iu);
    expect(text).not.toMatch(/not retained/iu);
    expect(text).not.toMatch(/never stored/iu);
  });

  it('labels the prompt field', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('label[for="image-prompt"]').exists()).toBe(true);
    expect(wrapper.find('#image-prompt').exists()).toBe(true);
  });

  it('disables Generate while the prompt is empty', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.generate-button').attributes('disabled')).toBeDefined();
  });

  it('enables Generate once a prompt is typed', async () => {
    const wrapper = await mountView();
    await wrapper.find('#image-prompt').setValue('a lighthouse');
    expect(wrapper.find('.generate-button').attributes('disabled')).toBeUndefined();
  });

  it('shows no Stop control while nothing is generating', async () => {
    expect((await mountView()).find('.cancel-button').exists()).toBe(false);
  });

  it('offers every reviewed model from the catalogue', async () => {
    const options = (await mountView()).findAll('#image-model option');
    expect(options.map((option) => option.text())).toEqual(['Rich Model', 'Minimal Model']);
  });

  it('selects the first reviewed model by default', async () => {
    const select = (await mountView()).find<HTMLSelectElement>('#image-model');
    expect(select.element.value).toBe(RICH.id);
  });

  // The behaviour this phase exists to demonstrate: the form's shape follows the selected model's
  // declared capabilities rather than being fixed for the panel.
  describe('controls follow the selected model', () => {
    it('renders every control for a model that declares them all', async () => {
      const wrapper = await mountView([RICH]);
      expect(wrapper.find('#image-negative').exists()).toBe(true);
      expect(wrapper.find('#image-steps').exists()).toBe(true);
      expect(wrapper.find('#image-width').exists()).toBe(true);
      expect(wrapper.find('#image-height').exists()).toBe(true);
      expect(wrapper.find('#image-guidance').exists()).toBe(true);
      expect(wrapper.find('#image-seed').exists()).toBe(true);
    });

    // Absent rather than disabled. A disabled control invites "why can't I use this?"; an absent one
    // plus the explanatory note answers it.
    it('omits the controls a model does not declare', async () => {
      const wrapper = await mountView([MINIMAL]);
      expect(wrapper.find('#image-negative').exists()).toBe(false);
      expect(wrapper.find('#image-width').exists()).toBe(false);
      expect(wrapper.find('#image-guidance').exists()).toBe(false);
      expect(wrapper.find('#image-seed').exists()).toBe(false);
    });

    it('still renders the control that model does declare', async () => {
      const wrapper = await mountView([MINIMAL]);
      expect(wrapper.find('#image-steps').exists()).toBe(true);
    });

    it('removes the controls when the visitor switches to a stricter model', async () => {
      const wrapper = await mountView([RICH, MINIMAL]);
      expect(wrapper.find('#image-seed').exists()).toBe(true);

      await wrapper.find('#image-model').setValue(MINIMAL.id);
      expect(wrapper.find('#image-seed').exists()).toBe(false);
      expect(wrapper.find('#image-negative').exists()).toBe(false);
    });

    // A slider offering 20 steps to a model whose ceiling is 8 would produce a request the server
    // refuses, so the bounds come from the model's own declared range.
    it('bounds each slider by the model\u2019s declared range', async () => {
      const wrapper = await mountView([MINIMAL]);
      const steps = wrapper.find('#image-steps');
      expect(steps.attributes('min')).toBe('1');
      expect(steps.attributes('max')).toBe('8');
    });

    it('uses the other model\u2019s range when it is selected', async () => {
      const wrapper = await mountView([RICH]);
      expect(wrapper.find('#image-steps').attributes('max')).toBe('20');
    });

    it('bounds the dimension sliders by the declared pixel range', async () => {
      const width = (await mountView([RICH])).find('#image-width');
      expect(width.attributes('min')).toBe('256');
      expect(width.attributes('max')).toBe('2048');
    });

    // Without this, a visitor who selects the stricter model and loses four controls would
    // reasonably think the page had broken.
    it('explains that each model declares its own controls', async () => {
      expect((await mountView()).text()).toMatch(/each model declares its own controls/iu);
    });

    it('names what the selected model offers', async () => {
      const text = (await mountView([RICH])).text();
      expect(text).toContain('a negative prompt');
      expect(text).toContain('1–20 steps');
    });

    it('reads as a grammatical list for a model with several controls', async () => {
      const text = (await mountView([RICH])).text();
      expect(text).toContain(
        'Rich Model offers a negative prompt, custom dimensions, guidance, a seed and 1–20 steps.'
      );
    });

    // Template conditionals produced "offers and 1–8 steps" here, because the empty branches left
    // the conjunction behind. A single-item list needs no conjunction at all.
    it('reads correctly for a model with only one control', async () => {
      const text = (await mountView([MINIMAL])).text();
      expect(text).toContain('Minimal Model offers 1–8 steps.');
      expect(text).not.toMatch(/offers\s+and/u);
    });

    it('never leaves a dangling conjunction for any model', async () => {
      for (const model of [RICH, MINIMAL]) {
        const text = (await mountView([model])).text();
        expect(text, `${model.name} capability sentence`).not.toMatch(/offers\s+and/u);
        expect(text, `${model.name} capability sentence`).not.toMatch(/,\s*\./u);
      }
    });
  });

  it('shows the model default for a control the visitor has not touched', async () => {
    const wrapper = await mountView([RICH]);
    expect(wrapper.find('label[for="image-steps"]').text()).toContain('model default: 20');
  });

  it('explains that more steps cost more', async () => {
    expect((await mountView([RICH])).text()).toMatch(/bills per step, so it also\s+costs more/iu);
  });

  it('explains what a seed does', async () => {
    expect((await mountView([RICH])).text()).toMatch(/reproduces the same image/iu);
  });

  // Visible but deliberately not live: announcing the count on every keystroke masks the useful
  // run status. `maxlength` on the editor is the programmatic limit.
  it('shows a quiet character count against the limit', async () => {
    const wrapper = await mountView();
    await wrapper.find('#image-prompt').setValue('12345');

    const counter = wrapper.find('.counter');
    expect(counter.text()).toContain('5');
    expect(counter.attributes('aria-live')).toBeUndefined();
  });

  describe('examples', () => {
    it('offers every prepared example', async () => {
      const wrapper = await mountView();
      for (const example of IMAGE_EXAMPLES) {
        expect(
          wrapper.find(`[data-example="${example.id}"]`).exists(),
          `${example.label} button`
        ).toBe(true);
      }
    });

    // A prepared prompt that spent money the moment it was clicked would be a trap in a panel that
    // bills per image.
    it('loads an example into the editor without generating it', async () => {
      const wrapper = await mountView();
      await wrapper.find(`[data-example="${IMAGE_EXAMPLES[0]!.id}"]`).trigger('click');

      const input = wrapper.find<HTMLTextAreaElement>('#image-prompt');
      expect(input.element.value).toBe(IMAGE_EXAMPLES[0]!.prompt);
      expect(wrapper.findAll('img')).toHaveLength(0);
    });

    it('explains what each example demonstrates', async () => {
      const wrapper = await mountView();
      const button = wrapper.find(`[data-example="${IMAGE_EXAMPLES[0]!.id}"]`);
      expect(button.attributes('title')).toBe(IMAGE_EXAMPLES[0]!.teaches);
    });
  });

  it('links the selected model to its catalog page', async () => {
    const wrapper = await mountView([RICH]);
    expect(wrapper.find(`a[href="${RICH.documentationUrl}"]`).exists()).toBe(true);
  });

  it('shows no run details before the first run', async () => {
    expect((await mountView()).find('.run-details').exists()).toBe(false);
  });

  it('shows no gallery before the first result', async () => {
    expect((await mountView()).find('.gallery').exists()).toBe(false);
  });

  it('shows no error before anything is generated', async () => {
    expect((await mountView()).find('[role="alert"]').exists()).toBe(false);
  });

  // Persistent but empty, so changing its text from "Generating" to "Image generated" is
  // announced reliably. Inserting a populated live region at completion is inconsistent across
  // screen readers.
  it('keeps an empty status region ready before the first run', async () => {
    const status = (await mountView()).find('[role="status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toBe('');
  });
});

describe('the reorganised layout', () => {
  // The panel was previously five stacked sections of equal weight, which put the prompt below a
  // paragraph of description and the generated image below everything else.
  it('puts the prompt ahead of the model settings', async () => {
    const wrapper = await mountView();
    const composer = wrapper.find('.composer').element;
    const settings = wrapper.find('details').element;

    const relation = composer.compareDocumentPosition(settings);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Collapsed, with the model named in the summary. That name matters more here than in most
  // panels: the two reviewed models differ by four controls, so which one is selected explains
  // the shape of the form.
  it('collapses the model settings but names the selected model', async () => {
    const wrapper = await mountView();
    const details = wrapper.find('details');

    expect(details.element.open).toBe(false);
    expect(details.find('summary').text()).toContain(RICH.name);
  });

  it('still allows the settings to be opened and edited', async () => {
    const wrapper = await mountView();
    await wrapper.find('summary').trigger('click');

    expect(wrapper.find('details').element.open).toBe(true);
    expect(wrapper.find('#image-model').exists()).toBe(true);
  });

  // Every model control stays reachable once expanded. Collapsing the section must not amount to
  // removing the controls that make this panel a comparison tool.
  it('keeps every control of the selected model available once expanded', async () => {
    const wrapper = await mountView();
    await wrapper.find('summary').trigger('click');

    for (const id of [
      '#image-model',
      '#image-negative',
      '#image-steps',
      '#image-width',
      '#image-height',
      '#image-guidance',
      '#image-seed'
    ]) {
      expect(wrapper.find(id).exists(), `${id} is reachable`).toBe(true);
    }
  });

  it('stays a single column until an image has been generated', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.workspace').classes()).not.toContain('workspace--split');
  });

  it('offers no run-details button before a run', async () => {
    expect((await mountView()).find('.run-details-button').exists()).toBe(false);
  });
});

describe('after an image is generated', () => {
  /**
   * Generates one image against a stubbed endpoint.
   *
   * Drives the real composable over a stubbed `fetch` rather than injecting a gallery entry,
   * because the wiring between a completed run and the output column is the thing under test.
   *
   * @returns The mounted wrapper, after the run has completed.
   */
  async function generateOnce() {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/metrics')
                ? { runId: 'run-1', costStatus: 'available', totalCostUsd: 0.001_25, requests: [] }
                : {
                    image: {
                      base64: 'AAAA',
                      mediaType: 'image/png',
                      byteLength: 2_048
                    },
                    receipt: {
                      runId: 'run-1',
                      task: 'create-image',
                      model: RICH.id,
                      gatewayRouted: true,
                      logIds: ['log-xyz'],
                      status: 'completed',
                      costStatus: 'pending',
                      elapsedMs: 3_200,
                      startedAt: '2026-04-01T09:15:00.000Z'
                    },
                    applied: {
                      prompt: 'a lighthouse in a storm',
                      model: RICH.id,
                      steps: 20,
                      width: 1_024,
                      height: 1_024
                    }
                  }
            ),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      )
    );

    const wrapper = await mountView();
    await wrapper.find('#image-prompt').setValue('a lighthouse in a storm');
    await wrapper.find('.generate-button').trigger('click');
    await flushPromises();
    return wrapper;
  }

  // The result now sits beside the prompt instead of below the settings and the run details, so
  // a visitor can see what they asked for and what came back at once.
  it('splits into two columns with the result beside the prompt', async () => {
    const wrapper = await generateOnce();

    expect(wrapper.find('.workspace').classes()).toContain('workspace--split');
    expect(wrapper.find('.workspace-output').find('.gallery').exists()).toBe(true);
  });

  it('reports the run and its cost when the details are opened', async () => {
    const wrapper = await generateOnce();
    await wrapper.find('.run-details-button').trigger('click');

    const text = openDialogText();
    expect(text).toContain('Run details');
    expect(text).toContain('log-xyz');
    expect(text).toMatch(/\$0\.001250/u);
  });

  it('keeps the details closed until asked', async () => {
    await generateOnce();
    expect(isDialogOpen()).toBe(false);
  });
});
