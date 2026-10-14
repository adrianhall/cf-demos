/**
 * @file Whether the chat panel is open, shared by the app bar's Chat toggle and the panel itself.
 *   The state is module-scoped rather than passed down, because the two components that need it sit
 *   on opposite sides of the shell: the toggle is in the app bar and the panel is a sibling of the
 *   routed main region. It is a single boolean, so there is nothing to keep consistent beyond it.
 *   Closing records that the user closed it deliberately, which lets the panel return focus to the
 *   toggle (WCAG 2.4.3) without the toggle having to know when that happened.
 */

import { computed, type ComputedRef, shallowRef } from 'vue';

/**
 * Whether the panel is open.
 */
const open = shallowRef(false);

/**
 * What {@link useChatPanel} returns.
 */
export interface UseChatPanel {
  /**
   * Whether the panel is open.
   */
  readonly open: ComputedRef<boolean>;
  /**
   * Open the panel.
   *
   * @returns Nothing.
   */
  show(): void;
  /**
   * Close the panel.
   *
   * @returns Nothing.
   */
  hide(): void;
  /**
   * Toggle the panel.
   *
   * @returns Nothing.
   */
  toggle(): void;
}

/**
 * Access the shared panel state.
 *
 * @returns The panel state and its actions.
 */
export function useChatPanel(): UseChatPanel {
  return {
    open: computed(() => open.value),
    show: () => {
      open.value = true;
    },
    hide: () => {
      open.value = false;
    },
    toggle: () => {
      open.value = !open.value;
    }
  };
}

/**
 * Close the panel and forget its state (tests only).
 *
 * @returns Nothing.
 */
export function resetChatPanel(): void {
  open.value = false;
}
