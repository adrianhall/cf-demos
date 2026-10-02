import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BeforeAfterComparison from '../../../src/client/features/remix-image/BeforeAfterComparison.vue';

/**
 * Mounts an accessible source/result comparison.
 */
function mountComparison() {
  return mount(BeforeAfterComparison, {
    props: {
      source: {
        base64: 'source',
        previewUri: 'data:image/png;base64,source',
        byteLength: 32,
        fileName: 'source.png'
      },
      result: { base64: 'result', mediaType: 'image/png', byteLength: 64 },
      fileName: 'playground-run.png'
    }
  });
}

describe('BeforeAfterComparison', () => {
  it('names the range slider and reports its value', () => {
    const wrapper = mountComparison();
    const slider = wrapper.find('#comparison-position');
    expect(slider.attributes('type')).toBe('range');
    expect(wrapper.find('label[for="comparison-position"]').text()).toContain('50%');
  });

  it('changes comparison position through keyboard-operable range input', async () => {
    const wrapper = mountComparison();
    await wrapper.find('#comparison-position').setValue('75');
    expect(wrapper.find('label[for="comparison-position"]').text()).toContain('75%');
    expect(wrapper.find('.slider-comparison').attributes('style')).toContain('--result-clip: 75%');
  });

  it('provides separately labelled source and result images without drag gestures', () => {
    const wrapper = mountComparison();
    expect(wrapper.findAll('img').map((image) => image.attributes('alt'))).toContain(
      'Source image'
    );
    expect(wrapper.findAll('img').map((image) => image.attributes('alt'))).toContain(
      'Remixed result'
    );
  });

  it('offers a result visibility toggle for the non-drag fallback', async () => {
    const wrapper = mountComparison();
    await wrapper.find('.toggle').trigger('click');
    expect(wrapper.find('.toggle').text()).toContain('Show separate result');
  });

  it('uses file metadata as the download action', () => {
    const link = mountComparison().find('.file a');
    expect(link.attributes('download')).toBe('playground-run.png');
    expect(link.text()).toContain('image/png');
  });
});
