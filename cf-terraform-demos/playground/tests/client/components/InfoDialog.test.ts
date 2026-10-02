/**
 * @file Tests for the hand-rolled modal. The reason this file is as long as it is: the component
 *   exists because `<dialog>` is unimplemented in jsdom and the Vuetify overlay stack is
 *   deliberately not registered, which means every behaviour a native dialog would have come for
 *   free is now application code. Focus handling, Escape, the Tab trap, and the scroll lock are
 *   exactly the parts a hand-rolled modal usually gets wrong, and they are invisible to anyone
 *   testing with a mouse.
 */

import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import InfoDialog from '../../../src/client/components/InfoDialog.vue';

/**
 * Mounts the dialog with a trigger button outside it.
 *
 * The trigger matters: focus restoration is only meaningful if something held focus beforehand, and
 * a test that opens the dialog from nothing cannot observe it.
 *
 * @param open Whether to start open.
 * @returns The mounted wrapper.
 */
function mountDialog(open = false) {
  const Host = defineComponent({
    data: () => ({ open }),
    methods: {
      /**
       * Closes the dialog, as the parent owns its open state.
       *
       * @returns Nothing.
       */
      close(): void {
        this.open = false;
      }
    },
    render() {
      return h('div', [
        h('button', { class: 'trigger' }, 'Open'),
        h(
          InfoDialog,
          { open: this.open, title: 'About This Panel', onClose: this.close },
          { default: () => [h('p', 'Explanatory text'), h('a', { href: '#x' }, 'A link')] }
        )
      ]);
    }
  });

  return mount(Host, { attachTo: document.body });
}

/**
 * Reads the dialog element from the document, wherever it was teleported.
 *
 * @returns The dialog, or `null` when closed.
 */
function dialogElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

describe('InfoDialog', () => {
  it('renders nothing while closed', () => {
    mountDialog(false);
    expect(dialogElement()).toBeNull();
  });

  it('renders its content when open', async () => {
    const wrapper = mountDialog(true);
    await nextTick();

    expect(dialogElement()?.textContent).toContain('Explanatory text');
    wrapper.unmount();
  });

  it('shows the title it was given', async () => {
    mountDialog(true);
    await nextTick();

    expect(dialogElement()?.textContent).toContain('About This Panel');
  });
});

describe('accessible naming', () => {
  // The dialog role without an accessible name is announced as an unlabelled dialog, which tells a
  // screen-reader user that something opened but not what.
  it('names itself from its own heading', async () => {
    mountDialog(true);
    await nextTick();

    const dialog = dialogElement();
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();

    const heading = document.getElementById(labelledBy ?? '');
    expect(heading?.textContent).toContain('About This Panel');
  });

  // `aria-modal` is what tells assistive technology the rest of the page is unavailable, which is
  // the claim the focus trap and the scroll lock actually implement.
  it('declares itself modal', async () => {
    mountDialog(true);
    await nextTick();

    expect(dialogElement()?.getAttribute('aria-modal')).toBe('true');
  });

  it('gives the close control a name rather than only a glyph', async () => {
    mountDialog(true);
    await nextTick();

    const close = document.body.querySelector('.close-button');
    expect(close?.getAttribute('aria-label')).toBe('Close');
  });

  // A panel renders two of these — the description and the run details — so a hard-coded heading
  // id would make `aria-labelledby` ambiguous on both. Both are mounted in *one* app here,
  // because that is the real case: `useId` counts per application instance, so two separately
  // mounted apps each start at `v-0` and comparing those would test the harness rather than the
  // component.
  it('uses a distinct heading id for each dialog in a panel', async () => {
    const Panel = defineComponent({
      render: () =>
        h('div', [
          h(InfoDialog, { open: true, title: 'About' }, { default: () => h('p', 'a') }),
          h(InfoDialog, { open: true, title: 'Run details' }, { default: () => h('p', 'b') })
        ])
    });

    mount(Panel, { attachTo: document.body });
    await nextTick();

    const ids = [...document.body.querySelectorAll('[role="dialog"]')].map((dialog) =>
      dialog.getAttribute('aria-labelledby')
    );

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('dismissal', () => {
  it('closes on the close button', async () => {
    mountDialog(true);
    await nextTick();

    document.body
      .querySelector('.close-button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(dialogElement()).toBeNull();
  });

  it('closes on Escape', async () => {
    mountDialog(true);
    await nextTick();

    dialogElement()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    await nextTick();

    expect(dialogElement()).toBeNull();
  });

  // Clicking the backdrop is the gesture most people try first, and `.self` is what keeps a click
  // inside the panel from bubbling out and closing it.
  it('closes on a backdrop click', async () => {
    mountDialog(true);
    await nextTick();

    const scrim = document.body.querySelector('.scrim');
    scrim?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(dialogElement()).toBeNull();
  });

  it('stays open when the click is inside the panel', async () => {
    mountDialog(true);
    await nextTick();

    dialogElement()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();

    expect(dialogElement()).not.toBeNull();
  });
});

describe('focus handling', () => {
  // Opening a modal and leaving focus behind it means a keyboard user has to tab through the whole
  // page to reach content that is visually in front of them.
  it('moves focus into the dialog on open', async () => {
    const wrapper = mountDialog(false);
    (document.body.querySelector('.trigger') as HTMLElement).focus();

    wrapper.vm.open = true;
    await nextTick();
    await nextTick();

    expect(dialogElement()?.contains(document.activeElement)).toBe(true);
  });

  // The counterpart: dismissing a modal has to put focus back where it was, or a keyboard user is
  // returned to the top of the document and has to find their place again.
  it('returns focus to the trigger on close', async () => {
    const wrapper = mountDialog(false);
    const trigger = document.body.querySelector('.trigger') as HTMLElement;
    trigger.focus();

    wrapper.vm.open = true;
    await nextTick();
    await nextTick();

    wrapper.vm.open = false;
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(trigger);
  });

  // Guards the `wasOpen` check in the watcher. Without it the initial `false` fires on mount and
  // steals focus from whatever the visitor was using.
  it('does not move focus when mounted closed', async () => {
    mountDialog(false);
    const trigger = document.body.querySelector('.trigger') as HTMLElement;
    trigger.focus();
    await nextTick();

    expect(document.activeElement).toBe(trigger);
  });

  // Tab has to cycle within the modal; otherwise focus walks out into the page behind it, which is
  // still rendered and still focusable.
  it('wraps Tab from the last focusable element back to the first', async () => {
    mountDialog(true);
    await nextTick();
    await nextTick();

    const dialog = dialogElement();
    const focusable = [...(dialog?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
    const last = focusable.at(-1);
    last?.focus();

    dialog?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );
    await nextTick();

    expect(document.activeElement).toBe(focusable[0]);
  });

  it('wraps Shift+Tab from the first focusable element to the last', async () => {
    mountDialog(true);
    await nextTick();
    await nextTick();

    const dialog = dialogElement();
    const focusable = [...(dialog?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])];
    focusable[0]?.focus();

    dialog?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    await nextTick();

    expect(document.activeElement).toBe(focusable.at(-1));
  });
});

describe('the page behind the modal', () => {
  it('locks scrolling while open', async () => {
    const wrapper = mountDialog(false);
    wrapper.vm.open = true;
    await nextTick();
    await nextTick();

    expect(document.body.style.overflow).toBe('hidden');
  });

  it('releases the lock on close', async () => {
    const wrapper = mountDialog(false);
    wrapper.vm.open = true;
    await nextTick();
    await nextTick();

    wrapper.vm.open = false;
    await nextTick();
    await nextTick();

    expect(document.body.style.overflow).toBe('');
  });

  // A route change while a modal is open unmounts it without a close event. Without the unmount
  // hook the page behind would stay permanently unscrollable, which looks like a frozen app.
  it('releases the lock if unmounted while still open', async () => {
    const wrapper = mountDialog(true);
    await nextTick();
    await nextTick();
    expect(document.body.style.overflow).toBe('hidden');

    wrapper.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  // The modal owns only the temporary lock, not whatever inline overflow an embedding shell had
  // already applied. Removing the property unconditionally would leak a layout change on close.
  it('restores a pre-existing body overflow value', async () => {
    document.body.style.overflow = 'clip';
    const wrapper = mountDialog(false);

    wrapper.vm.open = true;
    await nextTick();
    await nextTick();
    expect(document.body.style.overflow).toBe('hidden');

    wrapper.vm.open = false;
    await nextTick();
    await nextTick();
    expect(document.body.style.overflow).toBe('clip');
  });

  // An instance that never opened never owned the lock. Its unmount must not erase an overflow
  // value applied by the shell or by another overlay.
  it('does not touch body overflow when an unopened instance unmounts', () => {
    document.body.style.overflow = 'clip';
    const wrapper = mountDialog(false);
    wrapper.unmount();

    expect(document.body.style.overflow).toBe('clip');
  });
});
