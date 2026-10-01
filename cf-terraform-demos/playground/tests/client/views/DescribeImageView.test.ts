import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';
import { useCatalogueStore } from '../../../src/client/stores/catalogue';
import { useHandoffStore } from '../../../src/client/stores/handoff';
import DescribeImageView from '../../../src/client/views/DescribeImageView.vue';
import type { ImageMediaType } from '../../../src/images';

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
    global: {
      plugins: [pinia],
      stubs: {
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' },
        'v-btn': {
          props: ['disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }
      }
    }
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
  it('renders the panel heading', async () => {
    expect((await mountView()).text()).toContain('Describe Image');
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
    const text = (await mountView()).text();
    expect(text).toMatch(/assume your picture and question are logged/iu);
    expect(text).toMatch(/anything confidential/iu);
  });

  it('makes no promise that the picture is unretained', async () => {
    const text = (await mountView()).text();
    expect(text).not.toMatch(/not stored/iu);
    expect(text).not.toMatch(/not retained/iu);
  });

  // This panel has something extra to disclose: the visitor is uploading a picture, which may
  // carry faces, documents, or location data they have not thought about.
  it('warns before the file picker rather than after the result', async () => {
    const html = (await mountView()).html();
    expect(html.indexOf('assume your picture')).toBeLessThan(html.indexOf('dropzone'));
  });

  it('states that the verified email is recorded for attribution', async () => {
    expect((await mountView()).text()).toMatch(/verified email is recorded/iu);
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

    expect(wrapper.find('.preview').attributes('alt')).toBe('The picture you chose to describe');
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

  it('announces the character counter as it changes', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.counter').attributes('aria-live')).toBe('polite');
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
