/**
 * @file Tests for the panel frame. `PanelPage` is where the reorganisation actually happened: the
 *   title moved into the shell's header bar and everything explanatory moved behind one info
 *   button, so that the fold belongs to the work rather than to five blocks of equally-weighted
 *   description. The risk in that change is losing content rather than relocating it — a teleport
 *   with no target silently renders nothing, and a modal with no trigger is unreachable. These
 *   tests assert the destination of each piece, not merely that the component renders.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import PanelPage from '../../../src/client/components/PanelPage.vue';
import { findTask, type TaskId } from '../../../src/shared/tasks';
import {
  clickTeleported,
  createPanelTitleTarget,
  isDialogOpen,
  openDialogText,
  PANEL_TITLE_SLOT_ID
} from '../support/panel';

/**
 * Mounts the frame for one panel.
 *
 * @param taskId Panel to render.
 * @param description Extra prose for the description slot, as an inference panel supplies.
 * @returns The mounted wrapper.
 */
function mountPage(taskId: TaskId = 'create-image', description = '') {
  return mount(PanelPage, {
    props: { task: findTask(taskId)! },
    slots: {
      default: '<p class="body-content">The working area</p>',
      ...(description === '' ? {} : { description })
    }
  });
}

beforeEach(() => {
  createPanelTitleTarget();
});

describe('the panel title', () => {
  // The title is the most prominent text on the page but costs the content no vertical space,
  // which is the entire reason it moved. A teleport whose target is missing renders nothing at
  // all, so asserting it lands *in the header slot* is the assertion that matters.
  it('renders into the shell header slot rather than the panel body', async () => {
    const wrapper = mountPage('create-image');
    await nextTick();

    const slot = document.getElementById(PANEL_TITLE_SLOT_ID);
    expect(slot?.textContent).toContain('Create Image');
    expect(wrapper.find('.panel-title').exists()).toBe(false);
  });

  // One `h1` per page, in the header. Two would be a document with two titles; none would leave
  // the page unlabelled for anyone navigating by heading.
  it('is the page heading', async () => {
    mountPage('create-image');
    await nextTick();

    const headings = document.body.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toContain('Create Image');
  });

  it('renders the panel body in place', () => {
    expect(mountPage().find('.body-content').exists()).toBe(true);
  });
});

describe('the panel description', () => {
  it('is closed until the info button is used', async () => {
    mountPage('create-image');
    await nextTick();

    expect(isDialogOpen()).toBe(false);
  });

  it('opens from the info button beside the title', async () => {
    mountPage('create-image');
    await nextTick();
    await clickTeleported('.about-button');

    expect(isDialogOpen()).toBe(true);
  });

  // Each of these used to be its own block above the fold. They are kept together rather than
  // dropped: the task type is what someone searches the model catalog for, and the gateway line
  // is the demo's central claim.
  it('carries the task type, the summary, and the gateway claim', async () => {
    mountPage('create-image');
    await nextTick();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toContain('Text to image');
    expect(text).toContain('Turn a written description into a picture');
    expect(text).toContain('Routed through AI Gateway');
  });

  // A panel that performs no inference must not claim a gateway route, because that would be
  // claiming a cost and a log it does not produce.
  it('states that a local-only panel costs nothing', async () => {
    mountPage('view-tokens');
    await nextTick();
    await clickTeleported('.about-button');

    const text = openDialogText();
    expect(text).toContain('Runs in your browser — no inference, no cost');
    expect(text).not.toContain('Routed through AI Gateway');
  });

  // Where an inference panel's credit-and-logging disclosure goes. The slot is the reason that
  // disclosure is still exactly one click from every panel that spends money.
  it('includes whatever the panel adds through the description slot', async () => {
    mountPage('create-image', '<p class="panel-disclosure">Assume your prompt is logged.</p>');
    await nextTick();
    await clickTeleported('.about-button');

    expect(openDialogText()).toContain('Assume your prompt is logged');
  });

  it('closes again', async () => {
    mountPage('create-image');
    await nextTick();
    await clickTeleported('.about-button');
    expect(isDialogOpen()).toBe(true);

    await clickTeleported('.close-button');
    expect(isDialogOpen()).toBe(false);
  });

  // The button is named for what it opens rather than labelled "info", so a screen-reader user
  // hears which panel's description they are about to read.
  it('names the info button after the panel', async () => {
    mountPage('describe-image');
    await nextTick();

    const button = document.body.querySelector('.about-button');
    expect(button?.getAttribute('aria-label')).toBe('About Describe Image');
  });
});
