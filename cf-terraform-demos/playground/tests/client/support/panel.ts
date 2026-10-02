/**
 * @file Mounting support for views built on `PanelPage`. Two things in the restructured shell put
 *   content outside the component's own DOM subtree, so `wrapper.text()` alone no longer sees the
 *   whole panel. The title teleports into the shell's header bar, and a modal teleports to
 *   `document.body`. Both are deliberate — the title belongs in the header, and a modal clipped by
 *   the panel's layout grid would be a bug — but it means a test asserting on either has to look
 *   where the content actually lands. These helpers exist so each view test states what it is
 *   asserting rather than repeating the plumbing. `panelText()` is the one most tests want:
 *   everything the visitor can read, wherever it was rendered to.
 */

import { nextTick } from 'vue';
import type { mount } from '@vue/test-utils';

/**
 * Identifier of the shell's header slot, matching `App.vue`.
 */
export const PANEL_TITLE_SLOT_ID = 'panel-title-slot';

/**
 * Creates the shell's teleport target and clears anything a previous test teleported.
 *
 * Without the target, `PanelPage` logs "Failed to locate Teleport target" and drops the title, so
 * every assertion on a panel name fails for a reason unrelated to the test. Mounting the whole
 * shell for each view test would also work and would pull the sidebar, the cost meter, and the
 * session store into tests about one panel.
 *
 * @returns The target element, already attached to the document.
 */
export function createPanelTitleTarget(): HTMLElement {
  // Teleported nodes are not removed when a wrapper is unmounted by a previous test's garbage
  // collection, so stale titles and modals would otherwise accumulate on the body and make a
  // document-wide text assertion match content from an earlier test.
  document.body.innerHTML = '';

  const target = document.createElement('div');
  target.id = PANEL_TITLE_SLOT_ID;
  document.body.appendChild(target);
  return target;
}

/**
 * Reads everything a panel rendered, including its teleported title and any open modal.
 *
 * @param wrapper Mounted wrapper, used only to guarantee the panel has rendered.
 * @returns The visible text of the whole document, whitespace-collapsed so an assertion matches the
 *   rendered sentence rather than the template's line wrapping.
 */
export function panelText(wrapper: { html: () => string }): string {
  // Touched so a caller cannot pass an unmounted wrapper and get a confusing empty string from
  // the body instead of an error from the wrapper.
  wrapper.html();
  return (document.body.textContent ?? '').replaceAll(/\s+/gu, ' ').trim();
}

/**
 * Reads the text of the currently open modal.
 *
 * @returns The modal's text, whitespace-collapsed, or an empty string when none is open.
 */
export function openDialogText(): string {
  const dialog = document.body.querySelector('[role="dialog"]');
  return (dialog?.textContent ?? '').replaceAll(/\s+/gu, ' ').trim();
}

/**
 * Reports whether a modal is currently open.
 *
 * @returns `true` when a dialog is in the document.
 */
export function isDialogOpen(): boolean {
  return document.body.querySelector('[role="dialog"]') !== null;
}

/**
 * Finds a teleported element by selector, searching the whole document.
 *
 * @param selector CSS selector to match.
 * @returns The first matching element, or `null`.
 */
export function findTeleported(selector: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(selector);
}

/**
 * Clicks a teleported element.
 *
 * `wrapper.find()` searches the component's own subtree, so it cannot reach the title's info button
 * in the shell header or a close button inside a modal — both of which are teleported elsewhere in
 * the document. Dispatching against the real node is the only way to drive them, and it exercises
 * the same listener a visitor's click would.
 *
 * @param selector CSS selector for the element to click.
 * @returns A promise fulfilled once Vue has applied the resulting state change.
 * @throws {Error} When no element matches, so a renamed control fails loudly here rather than
 *   silently passing a later assertion that was never exercised.
 */
export async function clickTeleported(selector: string): Promise<void> {
  const element = findTeleported(selector);
  if (element === null) {
    throw new Error(`No element matches "${selector}" anywhere in the document.`);
  }

  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await nextTick();
}

/**
 * Presses a key on a teleported element.
 *
 * @param selector CSS selector for the element to receive the key.
 * @param key Key name, as `KeyboardEvent.key` reports it.
 * @returns A promise fulfilled once Vue has applied any resulting state change.
 * @throws {Error} When no element matches the selector.
 */
export async function pressKeyOn(selector: string, key: string): Promise<void> {
  const element = findTeleported(selector);
  if (element === null) {
    throw new Error(`No element matches "${selector}" anywhere in the document.`);
  }

  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await nextTick();
}

/**
 * The `global.stubs` option, as `mount` itself declares it.
 */
export type PanelStubs = NonNullable<NonNullable<Parameters<typeof mount>[1]>['global']>['stubs'];

/**
 * Global stubs every panel test needs.
 *
 * `v-btn` is stubbed to a plain `button` so `:disabled` is assertable as an attribute; only three
 * Vuetify components are registered in `main.ts`, so this is the whole surface a panel uses.
 *
 * The return type is derived from `mount`'s own options rather than written as a loose record, so a
 * malformed stub is a type error here instead of a confusing render failure in a test. It is read
 * off the public `mount` signature rather than imported from the package's internal `dist` types,
 * which are not part of its published entry point and would break on an upgrade.
 *
 * @returns Component stubs for `mount`'s `global.stubs` option.
 */
export function panelStubs(): PanelStubs {
  return {
    'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' },
    'v-btn': {
      props: ['disabled'],
      template: '<button :disabled="disabled"><slot /></button>'
    }
  };
}
