/**
 * @file Pure scroll-to-bottom helper for `ChatTranscript.vue`, kept separate from the component so
 * the null-ref guard (the transcript element can already be gone by the time a deferred watcher
 * callback runs -- a component unmount, or a `v-if` swap) is unit-testable directly with a plain
 * mock object, instead of only reachable through Vue's own watcher-scheduling timing. Mirrors
 * `demos/ai-chat/src/client/lib/scroll.ts` verbatim.
 */

/**
 * Scroll `region` to its bottom edge, or do nothing when `region` is `null`.
 *
 * `region` is `null` when the transcript's scroll container is not currently attached -- for
 * example, the component unmounted between a conversation update being scheduled and the deferred
 * `nextTick()` in `ChatTranscript.vue`'s watcher resolving.
 *
 * @param region The transcript's scroll container, or `null` if it is not currently mounted.
 */
export function scrollToBottom(region: HTMLElement | null): void {
  if (region !== null) {
    region.scrollTop = region.scrollHeight;
  }
}
