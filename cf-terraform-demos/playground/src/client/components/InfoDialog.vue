<script setup lang="ts">
/**
 * A modal that holds the explanatory text a panel used to print above the fold.
 *
 * Built from plain elements rather than `<dialog>` or a Vuetify overlay, for two reasons that pull
 * in the same direction. `HTMLDialogElement.showModal()` is unimplemented in jsdom, so a native
 * dialog's open state could not be asserted in this suite at all; and `main.ts` deliberately
 * registers only three Vuetify components, because the Playground's panels are bespoke and pulling
 * in the overlay stack to show a paragraph would ship a large component set for one interaction.
 *
 * Writing it by hand means the modal behaviours have to be written out explicitly, which is what
 * the rest of this file is: a labelled dialog role, focus moved in on open and returned to the
 * trigger on close, Tab cycling kept inside, Escape and backdrop dismissal, and the page behind
 * locked from scrolling. Those are the parts people skip, and skipping them is what makes a
 * hand-rolled modal a trap for anyone not using a mouse.
 */
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps<{
  /**
   * Whether the modal is showing. The parent owns this, so the trigger and the modal cannot
   * disagree about whether it is open.
   */
  open: boolean;
  /**
   * Heading for the modal, also its accessible name.
   */
  title: string;
}>();

const emit = defineEmits<{
  /**
   * Asked to close: Escape, the backdrop, or the close button.
   */
  close: [];
}>();

/**
 * Identifier tying the dialog to its heading through `aria-labelledby`.
 *
 * From `useId()` rather than a literal, because a panel renders more than one of these — one for
 * the panel description and one for the run details — and two elements sharing an `id` make the
 * `aria-labelledby` on both ambiguous.
 */
const headingId = useId();

const dialog = ref<HTMLElement | null>(null);

/**
 * Element that had focus when the modal opened, so it can be given focus back on close.
 *
 * Without this, dismissing the modal drops focus to the top of the document and a keyboard user has
 * to tab back to where they were — which, in a panel whose info button sits in the header bar,
 * means traversing the whole page.
 */
let previouslyFocused: HTMLElement | null = null;

/**
 * Inline overflow value that existed before the modal locked scrolling.
 *
 * Restored exactly rather than blindly removing the property on close. The application does not set
 * one today, but erasing a value owned by the shell or by an embedded host would make the modal
 * leak a layout change into code it does not own.
 */
let previousBodyOverflow = '';

/**
 * Whether this instance currently owns the body scroll lock.
 *
 * Without this, unmounting a dialog that was never opened would still restore an empty overflow
 * value and erase a lock or layout style owned by something else.
 */
let ownsScrollLock = false;

/**
 * Selector for the elements that can hold focus inside the modal.
 *
 * `:not([disabled])` and the negative-tabindex exclusion matter: a disabled control or one removed
 * from the tab order is still matched by the tag selectors, and including it would send focus
 * somewhere a keyboard user cannot see it.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
  + ' textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Lists the focusable elements currently inside the modal.
 *
 * Recomputed on each Tab rather than cached on open, because the content can change while the modal
 * is showing — the run-details modal gains a cost row when the gateway log resolves.
 *
 * @returns The focusable elements, in document order.
 */
function focusableElements(): HTMLElement[] {
  const root = dialog.value;
  return root === null ? [] : [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

/**
 * Keeps Tab inside the modal, wrapping at both ends.
 *
 * @param event The keydown being handled.
 * @returns Nothing; the event is prevented only when focus has to wrap.
 */
function trapTab(event: KeyboardEvent): void {
  const focusable = focusableElements();
  if (focusable.length === 0) {
    // Nothing to focus, so there is nothing to cycle between. Preventing the default here would
    // trap Tab with nowhere for it to go.
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;

  if (event.shiftKey && (active === first || active === dialog.value)) {
    event.preventDefault();
    last?.focus();
    return;
  }

  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
  }
}

/**
 * Handles the keys a modal owns while it is open.
 *
 * @param event The keydown being handled.
 * @returns Nothing; Escape requests a close and Tab is cycled.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }

  if (event.key === 'Tab') {
    trapTab(event);
  }
}

/**
 * Releases the scroll lock on the page behind the modal.
 *
 * Separated out because it has to run both when the modal closes and if the component is unmounted
 * while still open — a route change during a modal would otherwise leave the page permanently
 * unscrollable.
 *
 * @returns Nothing.
 */
function unlockScroll(): void {
  if (!ownsScrollLock) {
    return;
  }

  document.body.style.overflow = previousBodyOverflow;
  ownsScrollLock = false;
}

watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      previousBodyOverflow = document.body.style.overflow;
      ownsScrollLock = true;
      document.body.style.setProperty('overflow', 'hidden');

      // After the paint that renders the panel, since there is nothing to focus until then.
      await nextTick();
      (focusableElements()[0] ?? dialog.value)?.focus();
      return;
    }

    // Guarded on `wasOpen` so focus is only restored after a real open-then-close. Without it the
    // initial `false` would steal focus on mount, pulling it out of whatever the visitor was
    // using on the page.
    if (wasOpen === true) {
      unlockScroll();
      previouslyFocused?.focus();
      previouslyFocused = null;
    }
  },
  // `immediate` so a dialog whose `open` is already `true` on mount still locks scrolling and
  // takes focus. Nothing in the application mounts one that way today — every panel starts closed
  // — but a watcher that only reacts to *changes* leaves a silently broken modal waiting for the
  // first caller who does. The `wasOpen === true` guard above is what keeps this initial run from
  // stealing focus in the ordinary closed case, where `wasOpen` is `undefined`.
  { immediate: true }
);

onBeforeUnmount(unlockScroll);
</script>

<template>
  <!--
    Teleported to the body so the modal is not clipped by the panel's own layout. A stacking or
    overflow context anywhere up the tree would otherwise cut off a centred overlay, and the
    workspace grid below establishes exactly that.
  -->
  <Teleport to="body">
    <div v-if="props.open" class="scrim" @click.self="emit('close')">
      <!--
        `aria-modal` with the dialog role tells a screen reader the rest of the page is
        inert while this is showing, which matches what the focus trap and scroll lock
        actually do. `tabindex="-1"` makes the panel itself focusable as a fallback for
        content that has no focusable child of its own.
      -->
      <div
        ref="dialog"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="headingId"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="dialog-header">
          <h2 :id="headingId" class="dialog-title">{{ props.title }}</h2>
          <button type="button" class="close-button" aria-label="Close" @click="emit('close')">
            <!--
              `aria-hidden` on the glyph because the button already has an accessible name;
              without it the character is announced as stray content after the label.
            -->
            <span aria-hidden="true">&times;</span>
          </button>
        </header>

        <div class="dialog-body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  align-items: center;
  background-color: rgb(0 0 0 / 60%);
  display: flex;
  inset: 0;
  justify-content: center;
  padding: 1rem;
  position: fixed;
  z-index: 2400;
}

/*
  `max-height` with `overflow: auto` so a long explanation scrolls inside the modal rather than
  growing past the viewport, which on a phone would put the close button off screen.
*/
.dialog {
  background-color: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.75rem;
  box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 45%);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 2rem);
  max-width: 40rem;
  min-width: 0;
  width: 100%;
}

.dialog:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.dialog-header {
  align-items: flex-start;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  padding: 1rem 1.25rem;
}

.dialog-title {
  font-size: 1.125rem;
  margin: 0;
}

/*
  Sized to the minimum comfortable pointer and touch target rather than to the glyph, which on its
  own would be a few pixels across.
*/
.close-button {
  background: none;
  border: none;
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  flex: 0 0 auto;
  font-size: 1.5rem;
  line-height: 1;
  min-height: 2.25rem;
  min-width: 2.25rem;
}

.close-button:hover,
.close-button:focus-visible {
  color: rgb(var(--v-theme-on-surface));
}

/*
  The close button is usually the first — and in an About modal, only — element focused on open.
  A grey-to-white glyph change is too subtle to say where keyboard focus landed, so it gets the
  same independent outline as the info button that opened it.
*/
.close-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.dialog-body {
  overflow-y: auto;
  padding: 1.25rem;
}
</style>
