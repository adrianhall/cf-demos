import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PlannedPanelView from '../../../src/client/views/PlannedPanelView.vue';
import type { TaskId } from '../../../src/tasks';

/**
 * Mount the placeholder for one panel.
 *
 * @param taskId Panel to render.
 * @returns The mounted wrapper.
 */
function mountPlaceholder(taskId: TaskId) {
  return mount(PlannedPanelView, {
    props: { taskId },
    global: {
      stubs: { 'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' } }
    }
  });
}

describe('PlannedPanelView', () => {
  it('shows the panel name and its technical task type', () => {
    const text = mountPlaceholder('create-image').text();
    expect(text).toContain('Create Image');
    expect(text).toContain('Text to image');
  });

  // Naming the phase turns "come back later" into something a visitor can act on: they can read
  // the implementation plan and see what is coming and in what order.
  it('states the phase that will deliver the panel', () => {
    expect(mountPlaceholder('classify-image').text()).toContain('phase 7');
  });

  // A placeholder that leaves a visitor with nowhere to go has wasted their click. Pointing at
  // the panel that lands first costs a sentence.
  it('points the visitor at the panel that arrives first', () => {
    const wrapper = mountPlaceholder('chat');
    expect(wrapper.find('a[href="/view-tokens"]').exists()).toBe(true);
  });

  // A page that invites you to visit the page you are already on is noise dressed as help.
  it('does not link View Tokens to itself', () => {
    expect(mountPlaceholder('view-tokens').find('a[href="/view-tokens"]').exists()).toBe(false);
  });

  // The badge is read by screen readers in document order, so the "not built yet" message has to
  // be a real heading rather than styled text that only looks like one.
  it('announces the placeholder with a heading', () => {
    const wrapper = mountPlaceholder('chat');
    const heading = wrapper.find('#placeholder-heading');
    expect(heading.exists()).toBe(true);
    expect(heading.element.tagName).toBe('H2');
  });

  it('declares that an inference panel is routed through AI Gateway', () => {
    expect(mountPlaceholder('chat').text()).toContain('Routed through AI Gateway');
  });
});
