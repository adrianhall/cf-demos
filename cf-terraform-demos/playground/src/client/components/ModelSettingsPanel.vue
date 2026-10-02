<script setup lang="ts">
/**
 * The model-settings panel, collapsed to a single summary line by default.
 *
 * Collapsed because the settings were the third of five equally-weighted blocks and most of a visit
 * does not touch them: a visitor picks a model once, then runs several prompts against it. The
 * summary keeps the one fact they still need — which model is selected — visible while the controls
 * themselves are out of the way, so "Model settings (Llama 3.2 11B Vision)" answers at a glance the
 * question the expanded form answered with a whole section.
 *
 * Built on `<details>`/`<summary>` rather than a toggle and a `v-if`. The element already carries
 * the expanded/collapsed state in the accessibility tree, is keyboard-operable, and is findable by
 * the browser's own in-page search when collapsed — three things a hand-rolled disclosure has to
 * add back, usually incompletely.
 */
const props = defineProps<{
  /**
   * Name of the currently selected model, shown in the collapsed summary.
   *
   * Optional because the catalogue is fetched after mount, so there is a first paint with no
   * selection. The summary says "loading…" rather than showing an empty bracket.
   */
  modelName?: string | undefined;
  /**
   * Whether to start expanded. Defaults to collapsed.
   */
  initiallyOpen?: boolean;
}>();
</script>

<template>
  <details class="settings-panel" :open="props.initiallyOpen">
    <summary class="settings-summary">
      <span class="settings-label">Model settings</span>
      <span class="settings-model">({{ props.modelName ?? 'loading…' }})</span>
    </summary>

    <div class="settings-body">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.settings-panel {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.75rem;
  min-width: 0;
}

/*
  The browser's default triangle is replaced below with one that rotates, and `cursor: pointer`
  makes clear that the whole row is the control. Do not use `list-style: none` here: Safari and
  VoiceOver can stop exposing the summary's disclosure role and expanded state when that property
  is applied, even though the element still looks correct.
*/
.settings-summary {
  align-items: center;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-height: 2.75rem;
  padding: 0.625rem 1rem;
}

.settings-summary::-webkit-details-marker {
  display: none;
}

/* Firefox and the other engines that expose the standards-based marker pseudo-element. */
.settings-summary::marker {
  content: '';
}

.settings-summary:focus-visible {
  border-radius: 0.75rem;
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

/*
  A rotating caret drawn with a border, so there is a visible open/closed affordance without an
  icon font. `::before` on the summary keeps it in the flex row ahead of the label.
*/
.settings-summary::before {
  border-color: transparent transparent transparent rgb(var(--v-theme-on-surface-variant));
  border-style: solid;
  border-width: 0.3125rem 0 0.3125rem 0.4375rem;
  content: '';
  flex: 0 0 auto;
  height: 0;
  transition: transform 120ms ease;
  width: 0;
}

.settings-panel[open] > .settings-summary::before {
  transform: rotate(90deg);
}

.settings-label {
  font-size: 0.9375rem;
  font-weight: 600;
}

.settings-model {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.settings-body {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 1rem;
}

/* The caret communicates state without needing motion, so honour a request to remove it. */
@media (prefers-reduced-motion: reduce) {
  .settings-summary::before {
    transition: none;
  }
}
</style>
