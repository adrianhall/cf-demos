/**
 * @file One polite live region for the whole SPA (WCAG 4.1.3). Views call {@link announce} after a
 *   successful action whose only visible effect is something moving or disappearing (a deal
 *   changing column, a next action marked done), so screen-reader users hear the outcome too.
 *   `App.vue` renders the region once; failures keep using in-page `role="alert"` messages.
 */

import { type Ref, ref } from 'vue';

/**
 * The current announcement text, shared by every caller and rendered by `App.vue`.
 */
const message = ref('');

/**
 * Announce a status message politely.
 *
 * The region is cleared first and refilled on the next frame, so announcing the same text twice
 * (moving two deals to the same stage) is still read out the second time.
 *
 * @param text Short, complete sentence, for example “Renewal moved to Proposal.”.
 * @returns Nothing.
 */
export function announce(text: string): void {
  message.value = '';
  setTimeout(() => {
    message.value = text;
  }, 50);
}

/**
 * The live region's text, for `App.vue` to render.
 *
 * @returns The shared message ref.
 */
export function useAnnouncement(): Ref<string> {
  return message;
}
