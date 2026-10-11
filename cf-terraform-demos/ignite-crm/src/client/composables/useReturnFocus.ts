/**
 * @file Return keyboard focus to whatever opened a dialog, once it closes (WCAG 2.4.3). Vuetify's
 *   `VOverlay` restores focus only to a registered activator, and this app opens its dialogs from a
 *   `v-model` flag, often from a button in another component. Without this, Cancel, Escape, or a
 *   scrim click leaves focus on `<body>`, and keyboard and screen-reader users lose their place.
 */

import { nextTick, watch, type WatchSource } from 'vue';

/**
 * Remember the focused element when `open` becomes `true`, and focus it again when it becomes
 * `false`.
 *
 * If the remembered element has since left the document (for example a row that was replaced by the
 * save), focus falls back to the page's `h1`, so it still lands somewhere meaningful rather than on
 * `<body>`.
 *
 * @param open The dialog's `v-model` flag, or a getter/computed deriving it.
 * @returns Nothing; the watcher lives as long as the calling component.
 */
export function useReturnFocus(open: WatchSource<boolean>): void {
  let opener: HTMLElement | null = null;
  watch(open, async (isOpen) => {
    if (isOpen) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const target = opener;
    opener = null;
    // Wait for the overlay to finish closing; it may try to move focus itself.
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (target !== null && target !== document.body && target.isConnected) {
      target.focus();
      return;
    }
    focusPageHeading();
  });
}

/**
 * Focus the main heading, making it programmatically focusable first.
 *
 * @returns Nothing.
 */
export function focusPageHeading(): void {
  const heading = document.querySelector<HTMLElement>('#main h1');
  if (heading !== null) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
}

/**
 * After a list re-renders, focus the control with an exact accessible name, or the page heading if
 * that control no longer exists (WCAG 2.4.3). Used when the control the user just operated moves (a
 * card changing column) or disappears (a row marked done).
 *
 * @param label The `aria-label` of the control to focus, for example `Move Renewal to another
 *   stage`.
 * @returns Once focus has moved.
 */
export async function focusByLabel(label: string): Promise<void> {
  await nextTick();
  const target = [...document.querySelectorAll<HTMLElement>('#main [aria-label]')].find(
    (element) => element.getAttribute('aria-label') === label
  );
  if (target === undefined) {
    focusPageHeading();
    return;
  }
  target.focus();
}
