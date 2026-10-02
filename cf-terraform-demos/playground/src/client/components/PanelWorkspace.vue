<script setup lang="ts">
/**
 * Two-column working area for a run-and-result panel: input on the left, output on the right.
 *
 * The panels previously stacked five sections in one narrow column, which wasted roughly half the
 * width of a desktop window and pushed the result of a run off the bottom of the screen. Putting
 * the output beside the input means a visitor can see what they asked and what they got at the same
 * time — which is the whole point of a panel built for comparing models.
 *
 * Before the first run there is no output, so a half-width column of empty space beside the input
 * would be worse than no split at all: it reads as something failing to load. Until then the input
 * is centred as a single column, and the layout becomes two columns at the moment there is
 * something to put in the second one. `hasOutput` is the panel's own notion of that, not merely "a
 * run finished" — Describe Image switches as soon as a picture is chosen, because the preview is
 * itself worth showing beside the question.
 *
 * On a narrow screen the two stack, input first, because scrolling to the result is the natural
 * order when they cannot be seen together.
 */
const props = defineProps<{
  /**
   * Whether there is output worth giving a column to.
   */
  hasOutput: boolean;
}>();
</script>

<template>
  <div class="workspace" :class="{ 'workspace--split': props.hasOutput }">
    <div class="workspace-input">
      <slot name="input" />
    </div>

    <!--
      Rendered only when there is something to show, rather than always present and empty. An
      empty region announced to a screen reader is a promise of content that never arrives.
    -->
    <div v-if="props.hasOutput" class="workspace-output">
      <slot name="output" />
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  gap: 1.5rem;
  /*
    One centred column until there is output. `min()` rather than a bare `max-width` so the column
    still fits a narrow viewport, where 44rem would overflow.
  */
  grid-template-columns: min(44rem, 100%);
  justify-content: center;
  min-width: 0;
}

/*
  `minmax(0, 1fr)` rather than `1fr`: a grid track's implicit minimum is `auto`, so a wide result
  — a long description, or an image — would push its column past the container instead of
  shrinking. The explicit zero minimum is what keeps the split from overflowing.
*/
@media (min-width: 61.25rem) {
  .workspace--split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    justify-content: stretch;
  }
}

/*
  Both columns are their own stacking column, so a panel can put several sections in either slot
  and have them space consistently.
*/
.workspace-input,
.workspace-output {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}
</style>
