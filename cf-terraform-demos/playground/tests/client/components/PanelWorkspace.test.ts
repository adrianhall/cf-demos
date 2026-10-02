/**
 * @file Tests for the two-column working area. The rule being pinned is when the layout splits. A
 *   half-width column of empty space beside the input reads as something failing to load, so the
 *   second column appears only when there is something to put in it — and the panels were
 *   previously a single narrow column that pushed the result of a run off the bottom of the screen,
 *   which is what the split exists to fix.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PanelWorkspace from '../../../src/client/components/PanelWorkspace.vue';

/**
 * Mounts the workspace with content in both slots.
 *
 * @param hasOutput Whether there is output to show.
 * @returns The mounted wrapper.
 */
function mountWorkspace(hasOutput: boolean) {
  return mount(PanelWorkspace, {
    props: { hasOutput },
    slots: {
      input: '<p class="the-input">Ask something</p>',
      output: '<p class="the-output">An answer</p>'
    }
  });
}

describe('PanelWorkspace', () => {
  it('always renders the input', () => {
    expect(mountWorkspace(false).find('.the-input').exists()).toBe(true);
  });

  // Not merely hidden: an empty region in the accessibility tree is a promise of content that
  // never arrives, so the output column is absent until it has something in it.
  it('renders no output column before there is output', () => {
    const wrapper = mountWorkspace(false);
    expect(wrapper.find('.the-output').exists()).toBe(false);
    expect(wrapper.find('.workspace-output').exists()).toBe(false);
  });

  it('renders the output once there is some', () => {
    expect(mountWorkspace(true).find('.the-output').exists()).toBe(true);
  });

  // The class is what the stylesheet keys the two-column grid off, so it is the observable form of
  // "the layout has split". Asserted rather than the computed width, which jsdom does not resolve.
  it('marks itself split only when there is output', async () => {
    const wrapper = mountWorkspace(false);
    expect(wrapper.find('.workspace').classes()).not.toContain('workspace--split');

    await wrapper.setProps({ hasOutput: true });
    expect(wrapper.find('.workspace').classes()).toContain('workspace--split');
  });

  // Input first in document order, so on a narrow screen — where the two stack — a visitor reads
  // what they asked before what came back, and a screen reader does the same.
  it('places the input before the output in document order', () => {
    const html = mountWorkspace(true).html();
    expect(html.indexOf('the-input')).toBeGreaterThan(-1);
    expect(html.indexOf('the-input')).toBeLessThan(html.indexOf('the-output'));
  });
});
