<script setup lang="ts">
/**
 * A safety model's verdict: the decision, and the categories behind it.
 *
 * A separate component from {@link RankedLabels} rather than a variant of it, because the two
 * render fundamentally different things. A ranking has scores and an order; a verdict has neither.
 * There is **no confidence figure anywhere in this component**, and that is deliberate: the model
 * reports none, and a bar at 100% would be the single most misleading element the panel could
 * draw.
 *
 * The verdict is rendered as text rather than as a colour alone. A red or green badge carrying the
 * entire meaning fails for anyone who cannot distinguish them, so colour is reinforcement here and
 * the words do the work.
 */
import type { ClassificationVerdict } from '../../../shared/classify-text';

const props = defineProps<{
  /**
   * The verdict to render.
   */
  verdict: ClassificationVerdict;
  /**
   * What the model's taxonomy is called, shown so the categories are not read as general-purpose
   * topic labels.
   */
  labelSetName: string;
}>();
</script>

<template>
  <div class="verdict">
    <!--
      `role="status"` rather than `alert`: this is the result of an action the visitor took, not an
      unexpected interruption. An alert would be announced with a level of urgency the content does
      not warrant, including for the safe case.
    -->
    <p
      class="decision"
      :class="props.verdict.safe ? 'decision--safe' : 'decision--unsafe'"
      role="status"
    >
      <!--
        The word carries the meaning; the colour only reinforces it. The icon is hidden from
        assistive technology because the adjacent text already says the same thing.
      -->
      <span aria-hidden="true" class="marker">{{ props.verdict.safe ? '✓' : '!' }}</span>
      <span class="decision-text">
        {{
          props.verdict.safe
            ? 'No category in this taxonomy was flagged.'
            : 'Flagged against this taxonomy.'
        }}
      </span>
    </p>

    <p class="taxonomy">
      Judged against the <strong>{{ props.labelSetName }}</strong
      >. These are content-safety categories, not general-purpose topic labels, and this model
      reports no confidence score for its decision.
    </p>

    <div v-if="props.verdict.categories.length > 0" class="categories">
      <h4 class="categories-heading">Categories cited</h4>
      <ul class="category-list">
        <li v-for="category in props.verdict.categories" :key="category.code" class="category">
          <span class="code">{{ category.code }}</span>
          <span class="name">{{ category.name }}</span>
        </li>
      </ul>
    </div>

    <!--
      A code outside the published taxonomy means the model's category set has moved. Shown rather
      than dropped, and deliberately without an invented name: naming it would be this demo making
      up a meaning for a safety category.
    -->
    <div v-if="props.verdict.unrecognisedCategories.length > 0" class="unrecognised">
      <h4 class="categories-heading">Codes outside the published taxonomy</h4>
      <ul class="category-list">
        <li
          v-for="code in props.verdict.unrecognisedCategories"
          :key="code"
          class="category category--unknown"
        >
          <span class="code">{{ code }}</span>
          <span class="name">Not in the reviewed taxonomy</span>
        </li>
      </ul>
      <p class="hint">
        This model returned a category this application has no published name for, so it is shown as
        the model reported it.
      </p>
    </div>
  </div>
</template>

<style scoped>
.verdict {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.decision {
  align-items: center;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.5rem;
  display: flex;
  gap: 0.6rem;
  margin: 0;
  padding: 0.75rem;
}

/*
  A left border as well as a tint, so the two states remain distinguishable in a high-contrast
  mode that drops background colours.
*/
.decision--safe {
  border-left: 4px solid rgb(var(--v-theme-success));
}

.decision--unsafe {
  border-left: 4px solid rgb(var(--v-theme-warning));
}

.marker {
  font-weight: 700;
}

.decision-text {
  font-weight: 500;
}

.taxonomy,
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

.categories-heading {
  font-size: 0.9375rem;
  margin: 0 0 0.4rem;
}

.category-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.category {
  align-items: baseline;
  display: flex;
  gap: 0.6rem;
}

.code {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.25rem;
  flex: none;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  padding: 0.1rem 0.4rem;
}

.category--unknown .code {
  border: 1px dashed rgb(var(--v-theme-outline));
}

.name {
  overflow-wrap: anywhere;
}

.unrecognised {
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  padding-top: 0.75rem;
}
</style>
