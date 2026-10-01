import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createTestingPinia } from '@pinia/testing';
import { mount, flushPromises } from '@vue/test-utils';
import type { GalleryEntry } from '../../../src/client/features/create-image/gallery';
import ImageGallery from '../../../src/client/features/create-image/ImageGallery.vue';
import { useHandoffStore } from '../../../src/client/stores/handoff';

/**
 * Builds a gallery entry.
 *
 * @param overrides Fields to replace on a default PNG entry.
 * @returns An entry to render.
 */
function entry(overrides: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    runId: 'run-1',
    image: { base64: 'AAAA', mediaType: 'image/png', byteLength: 2_048 },
    applied: {
      prompt: 'a lighthouse in a storm',
      model: '@cf/test/model',
      steps: 12,
      width: 1_024,
      height: 1_024,
      guidance: 7.5
    },
    modelName: 'Rich Model',
    ...overrides
  };
}

/**
 * Mounts the gallery with a real router over memory history.
 *
 * A real router rather than a stub, because the handoff is a navigation _and_ a state write, and
 * the pair only means anything together: the picture must be waiting in the store by the time the
 * other panel is reached. A push spy would let a broken order pass.
 *
 * @param entries Results to render.
 * @returns The mounted wrapper and the router, so a test can read the resulting route.
 */
function mountGallery(entries: GalleryEntry[]) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/describe-image', component: { template: '<div />' } }
    ]
  });

  const wrapper = mount(ImageGallery, {
    props: { entries },
    global: {
      plugins: [pinia, router],
      stubs: {
        'v-btn': {
          props: ['disabled'],
          template: '<button :disabled="disabled"><slot /></button>'
        }
      }
    }
  });

  return Object.assign(wrapper, { pinia, router });
}

describe('ImageGallery', () => {
  it('renders nothing when there are no results', () => {
    expect(mountGallery([]).find('section').exists()).toBe(false);
  });

  it('renders one item per result', () => {
    const wrapper = mountGallery([entry({ runId: 'a' }), entry({ runId: 'b' })]);
    expect(wrapper.findAll('li')).toHaveLength(2);
  });

  it('renders the image from a data URI built on the sniffed media type', () => {
    const image = mountGallery([entry()]).find('img');
    expect(image.attributes('src')).toBe('data:image/png;base64,AAAA');
  });

  // Nothing here has looked at the picture, so the alt text names the prompt and labels it as such
  // rather than asserting what the image contains.
  it('gives every image alt text naming the prompt it came from', () => {
    const image = mountGallery([entry()]).find('img');
    expect(image.attributes('alt')).toBe(
      'Image generated from the prompt: a lighthouse in a storm'
    );
  });

  it('never renders an image without alt text', () => {
    const wrapper = mountGallery([entry({ runId: 'a' }), entry({ runId: 'b' })]);
    for (const image of wrapper.findAll('img')) {
      expect(image.attributes('alt')).toBeTruthy();
    }
  });

  // Intrinsic dimensions let the browser reserve space before the image paints, which avoids the
  // layout shift of a multi-megabyte image arriving.
  it('declares the intrinsic dimensions when the model reported them', () => {
    const image = mountGallery([entry()]).find('img');
    expect(image.attributes('width')).toBe('1024');
    expect(image.attributes('height')).toBe('1024');
  });

  describe('the settings it reports', () => {
    // Listing the settings per result is what makes the gallery a comparison tool rather than a
    // scrapbook: two images of one prompt at different step counts only teach something if you can
    // see which was which.
    it('shows the model, steps, size, and guidance', () => {
      const text = mountGallery([entry()]).text();
      expect(text).toContain('Rich Model');
      expect(text).toContain('12');
      expect(text).toContain('1024');
      expect(text).toContain('7.5');
    });

    it('shows the prompt beside the image', () => {
      expect(mountGallery([entry()]).text()).toContain('a lighthouse in a storm');
    });

    it('shows a negative prompt when one was applied', () => {
      const wrapper = mountGallery([
        entry({ applied: { prompt: 'x', model: 'm', negativePrompt: 'people, cars' } })
      ]);
      expect(wrapper.text()).toContain('people, cars');
    });

    it('omits the negative prompt when none was applied', () => {
      expect(mountGallery([entry()]).text()).not.toContain('Avoiding:');
    });

    // A model without a control has no value to report, and showing a blank row would imply the
    // setting existed and was left empty.
    it('omits a setting the model does not support', () => {
      const wrapper = mountGallery([entry({ applied: { prompt: 'x', model: 'm', steps: 4 } })]);
      expect(wrapper.text()).not.toContain('Guidance');
      expect(wrapper.text()).not.toContain('Size');
    });

    it('shows a seed when one was applied', () => {
      const wrapper = mountGallery([entry({ applied: { prompt: 'x', model: 'm', seed: 4_242 } })]);
      expect(wrapper.text()).toContain('4242');
    });

    it('reports the file format and size', () => {
      const text = mountGallery([entry()]).text();
      expect(text).toContain('PNG');
      expect(text).toContain('2 KB');
    });
  });

  describe('downloading', () => {
    it('offers a download with the extension matching the sniffed type', () => {
      const link = mountGallery([entry()]).find('a.download');
      expect(link.attributes('download')).toBe('playground-run-1.png');
    });

    // "Download" alone does not say what is about to be saved, and the format is not conveyed
    // anywhere else for a screen-reader user.
    it('names the format in the accessible label', () => {
      const link = mountGallery([entry()]).find('a.download');
      expect(link.attributes('aria-label')).toBe('Download this image as PNG');
    });

    it('points the download at the image itself', () => {
      const link = mountGallery([entry()]).find('a.download');
      expect(link.attributes('href')).toBe('data:image/png;base64,AAAA');
    });

    it('names a JPEG download correctly', () => {
      const wrapper = mountGallery([
        entry({ image: { base64: 'AAAA', mediaType: 'image/jpeg', byteLength: 10 } })
      ]);
      expect(wrapper.find('a.download').attributes('download')).toBe('playground-run-1.jpg');
    });
  });

  // The images are transient by design — no R2 bucket, no retention policy — and a visitor who
  // reloads and loses their results deserves to have been told.
  //
  // Scoped to this demo's own storage, which is a claim it can keep. Phrasing it as "nothing is
  // stored anywhere" would extend it to AI Gateway's retention, which this application does not
  // control and must not speak for.
  it('states that this demo keeps no copy of a result', () => {
    expect(mountGallery([entry()]).text()).toMatch(/this demo keeps no copy/iu);
  });

  it('does not claim that nothing is stored anywhere', () => {
    const text = mountGallery([entry()]).text();
    expect(text).not.toMatch(/nothing is stored on the server/iu);
    expect(text).not.toMatch(/not retained/iu);
  });

  it('labels itself for assistive technology', () => {
    const section = mountGallery([entry()]).find('section');
    expect(section.attributes('aria-labelledby')).toBe('gallery-heading');
  });

  // A list rather than a run of divs, so a screen reader announces how many results there are.
  it('uses a list so the result count is conveyed', () => {
    const wrapper = mountGallery([entry({ runId: 'a' }), entry({ runId: 'b' })]);
    expect(wrapper.findAll('ol > li')).toHaveLength(2);
  });
});

describe('handing an image to Describe Image', () => {
  // The pairing is the point of the button. This gallery's alt text can only name the prompt,
  // because nothing has looked at the picture; Describe Image is the panel that can say what was
  // actually produced.
  it('offers a button for each result', () => {
    const wrapper = mountGallery([entry({ runId: 'a' }), entry({ runId: 'b' })]);
    expect(wrapper.findAll('[data-describe]')).toHaveLength(2);
  });

  it('navigates to the Describe Image panel', async () => {
    const wrapper = mountGallery([entry()]);
    await wrapper.find('[data-describe]').trigger('click');
    await flushPromises();

    expect(wrapper.router.currentRoute.value.path).toBe('/describe-image');
  });

  // The bytes travel through the store rather than the URL. A route parameter would put several
  // megabytes of base64 into browser history and into any intermediary's logs, which is exactly
  // what this demo refuses to do with a prompt.
  it('stages the image in the store rather than in the URL', async () => {
    const wrapper = mountGallery([entry()]);
    await wrapper.find('[data-describe]').trigger('click');
    await flushPromises();

    const handoff = useHandoffStore(wrapper.pinia);
    expect(handoff.pending).toMatchObject({ base64: 'AAAA', mediaType: 'image/png' });
    expect(wrapper.router.currentRoute.value.fullPath).not.toContain('AAAA');
  });

  it('records where the picture came from, since it has no file name', async () => {
    const wrapper = mountGallery([entry()]);
    await wrapper.find('[data-describe]').trigger('click');
    await flushPromises();

    expect(useHandoffStore(wrapper.pinia).pending?.origin).toContain('Rich Model');
  });

  // Consumed on read, so returning to the panel later does not silently reload a picture the
  // visitor has moved on from.
  it('clears the staged picture once it is taken', async () => {
    const wrapper = mountGallery([entry()]);
    await wrapper.find('[data-describe]').trigger('click');
    await flushPromises();

    const handoff = useHandoffStore(wrapper.pinia);
    expect(handoff.take()).toBeDefined();
    expect(handoff.take()).toBeUndefined();
  });
});
