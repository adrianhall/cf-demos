<script setup lang="ts">
/**
 * The circled "i" that opens an {@link InfoDialog}.
 *
 * Its own component because the panel header and the output heading both need one, and because the
 * thing that makes an icon-only button work is easy to leave out: it has no visible text, so
 * without an explicit accessible name it is announced as "button" and nothing else. Requiring the
 * `label` prop means a call site cannot add one of these without saying what it opens.
 *
 * No icon font is installed — `@mdi` is deliberately absent — so the glyph is a character. That
 * also keeps it legible at any zoom level without a webfont request.
 */
const props = defineProps<{
  /**
   * Accessible name, stating what the button reveals rather than that it is an info button. "About
   * this panel" is useful; "info" is not.
   */
  label: string;
}>();

const emit = defineEmits<{
  /**
   * The button was activated.
   */
  activate: [];
}>();
</script>

<template>
  <button
    type="button"
    class="info-button"
    :aria-label="props.label"
    :title="props.label"
    @click="emit('activate')"
  >
    <!--
      `aria-hidden` because the button is already named by `aria-label`. Without it a screen
      reader announces the glyph as well, and "i" after the label is noise.
    -->
    <span class="glyph" aria-hidden="true">i</span>
  </button>
</template>

<style scoped>
/*
  A fixed 1.75rem circle: large enough to be a comfortable target next to a heading, small enough
  not to compete with the heading itself. `flex: 0 0 auto` stops it stretching when it sits in a
  flex row beside a long title.
*/
.info-button {
  align-items: center;
  background: none;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 50%;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  height: 1.75rem;
  justify-content: center;
  padding: 0;
  width: 1.75rem;
}

.info-button:hover,
.info-button:focus-visible {
  border-color: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-primary));
}

/*
  A border recolour alone is too subtle for an icon-only control, especially because the initial
  border is already visible. The independent 2px outline makes keyboard focus unambiguous against
  either the header bar or an output panel.
*/
.info-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.glyph {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1rem;
  font-style: italic;
  font-weight: 700;
  line-height: 1;
}
</style>
