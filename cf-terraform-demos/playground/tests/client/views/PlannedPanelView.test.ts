import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PlannedPanelView from '../../../src/client/views/PlannedPanelView.vue';
import type { TaskId } from '../../../src/shared/tasks';
import {
  clickTeleported,
  createPanelTitleTarget,
  isDialogOpen,
  openDialogText,
  panelStubs,
  panelText
} from '../support/panel';

/**
 * Mount the placeholder for one panel.
 *
 * @param taskId Panel to render.
 * @returns The mounted wrapper.
 */
function mountPlaceholder(taskId: TaskId) {
  return mount(PlannedPanelView, {
    props: { taskId },
    global: { stubs: panelStubs() }
  });
}

/**
 * Opens the panel's description modal.
 *
 * The trigger is teleported into the shell's header, so it is clicked through the document rather
 * than through the wrapper's own subtree.
 *
 * @returns A promise fulfilled once the modal has rendered.
 */
async function openAbout(): Promise<void> {
  await clickTeleported('.about-button');
}

beforeEach(() => {
  createPanelTitleTarget();
});

describe('PlannedPanelView', () => {
  // The name is teleported into the shell's header bar and the task type now lives in the
  // description modal, so neither is in the component's own subtree any more. Both are still one
  // click apart for a visitor, which is what these two assertions check.
  it('shows the panel name in the header', () => {
    const wrapper = mountPlaceholder('create-image');
    expect(panelText(wrapper)).toContain('Create Image');
  });

  it('describes the technical task type in the panel description', async () => {
    mountPlaceholder('create-image');
    await openAbout();

    expect(openDialogText()).toContain('Text to image');
  });

  // The description has to be reachable, not merely present. A modal with no trigger would be
  // content nobody can get to.
  it('opens its description from the header info button', async () => {
    mountPlaceholder('create-image');
    expect(isDialogOpen()).toBe(false);

    await openAbout();
    expect(isDialogOpen()).toBe(true);
  });

  // Naming the phase turns "come back later" into something a visitor can act on: they can read
  // the implementation plan and see what is coming and in what order.
  it('states the phase that will deliver the panel', () => {
    expect(mountPlaceholder('classify-image').text()).toContain('phase 7');
  });

  // A placeholder that leaves a visitor with nowhere to go has wasted their click. Pointing at
  // the panel that lands first costs a sentence.
  it('points the visitor at a panel they can use now', () => {
    const wrapper = mountPlaceholder('create-video');
    expect(wrapper.find('a[href="/view-tokens"]').exists()).toBe(true);
  });

  // A page that invites you to visit the page you are already on is noise dressed as help.
  it('does not link View Tokens to itself', () => {
    expect(mountPlaceholder('view-tokens').find('a[href="/view-tokens"]').exists()).toBe(false);
  });

  it('does not link Chat to itself', () => {
    expect(mountPlaceholder('chat').find('a[href="/chat"]').exists()).toBe(false);
  });

  // Both delivered panels are offered, so a visitor sees one that calls a model and one that does
  // not — which is the distinction the whole demo is built around.
  it('points the visitor at both delivered panels', () => {
    const wrapper = mountPlaceholder('create-image');
    expect(wrapper.find('a[href="/chat"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/view-tokens"]').exists()).toBe(true);
  });

  // The badge is read by screen readers in document order, so the "not built yet" message has to
  // be a real heading rather than styled text that only looks like one.
  it('announces the placeholder with a heading', () => {
    const wrapper = mountPlaceholder('chat');
    const heading = wrapper.find('#placeholder-heading');
    expect(heading.exists()).toBe(true);
    expect(heading.element.tagName).toBe('H2');
  });

  it('declares that an inference panel is routed through AI Gateway', async () => {
    mountPlaceholder('chat');
    await openAbout();

    expect(openDialogText()).toContain('Routed through AI Gateway');
  });
});
