/**
 * @file Tests for the info button. An icon-only button has no visible text, so without an explicit
 *   accessible name it is announced as "button" and nothing else. That is the whole reason this
 *   component exists rather than a bare `<button>` at each call site, and it is what these tests
 *   hold it to.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InfoButton from '../../../src/client/components/InfoButton.vue';

describe('InfoButton', () => {
  it('names itself from the label it was given', () => {
    const wrapper = mount(InfoButton, { props: { label: 'About Create Image' } });
    expect(wrapper.attributes('aria-label')).toBe('About Create Image');
  });

  // The same text as a tooltip, so a sighted mouse user gets the explanation too rather than
  // having to guess what an "i" opens.
  it('offers the label as a tooltip as well', () => {
    const wrapper = mount(InfoButton, { props: { label: 'Run details' } });
    expect(wrapper.attributes('title')).toBe('Run details');
  });

  it('emits on activation', async () => {
    const wrapper = mount(InfoButton, { props: { label: 'About' } });
    await wrapper.trigger('click');

    expect(wrapper.emitted('activate')).toHaveLength(1);
  });

  // `type="button"` because these sit inside panels that also contain form controls; the default
  // `submit` would make an info button submit a form.
  it('declares itself a plain button rather than a submit control', () => {
    expect(mount(InfoButton, { props: { label: 'About' } }).attributes('type')).toBe('button');
  });

  // The glyph is decorative: the button is already named, so announcing "i" afterwards is noise.
  it('hides its glyph from assistive technology', () => {
    const wrapper = mount(InfoButton, { props: { label: 'About' } });
    expect(wrapper.find('.glyph').attributes('aria-hidden')).toBe('true');
  });
});
