<script setup lang="ts">
/**
 * A ranked, scored result: labels with their scores, rendered as a table with a bar in each row.
 *
 * Shared rather than owned by Classify Image, because Classify Text in a later phase renders the
 * same shape. Sharing the component is what stops two panels inventing two different vocabularies
 * for the same number.
 *
 * It is a real `table` rather than a list of styled divs. The data genuinely is tabular — rank,
 * label, score — and a table gives a screen-reader user row and column context, and a count of
 * rows, for free. The bar lives _inside_ the score cell beside the number rather than replacing it,
 * so the bar is decoration on a value that is already readable as text. That is the whole
 * accessibility argument for this component: nothing here is conveyed by bar length or by colour
 * alone, and removing every bar would lose no information at all.
 */
import { barWidthPercent, formatScore } from './ranked-labels';

const props = defineProps<{
  /**
   * The ranked labels, highest score first.
   */
  labels: { rank: number; label: string; score: number }[];
  /**
   * Accessible caption describing what was ranked, rendered as the table's visible caption.
   */
  caption: string;
}>();
</script>

<template>
  <table class="ranked-labels">
    <caption class="caption">
      {{
        props.caption
      }}
    </caption>
    <thead>
      <tr>
        <th scope="col" class="rank-column">Rank</th>
        <th scope="col">Label</th>
        <th scope="col" class="score-column">Score</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in props.labels" :key="entry.label" class="row" :data-label="entry.label">
        <td class="rank-column">{{ entry.rank }}</td>
        <!--
          `th` with `scope="row"` rather than a `td`: the label is what identifies the row, so a
          screen reader announces it alongside the score instead of reading a bare percentage.
        -->
        <th scope="row" class="label-cell">{{ entry.label }}</th>
        <td class="score-column">
          <div class="score">
            <span class="score-value">{{ formatScore(entry.score) }}</span>
            <!--
              `aria-hidden` because the number beside it already says this, and an announced bar
              would read the same value twice. The bar is a visual aid to comparison, not a
              carrier of information.
            -->
            <span class="bar-track" aria-hidden="true">
              <span class="bar-fill" :style="{ width: `${barWidthPercent(entry.score)}%` }"></span>
            </span>
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.ranked-labels {
  border-collapse: collapse;
  width: 100%;
}

.caption {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin-bottom: 0.5rem;
  text-align: left;
}

th,
td {
  padding: 0.5rem 0.75rem 0.5rem 0;
  text-align: left;
  vertical-align: middle;
}

thead th {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 600;
}

.row:not(:last-child) td,
.row:not(:last-child) th {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
}

.rank-column {
  width: 3rem;
}

/*
  The score column takes a fixed proportion rather than sizing to content, so every bar shares one
  track width and two rows are genuinely comparable by eye.
*/
.score-column {
  padding-right: 0;
  width: 45%;
}

.label-cell {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.score {
  align-items: center;
  display: flex;
  gap: 0.6rem;
}

/*
  `font-variant-numeric: tabular-nums` so the percentages line up vertically; proportional digits
  make a column of numbers ragged and harder to compare, which is the one job this column has.
*/
.score-value {
  font-variant-numeric: tabular-nums;
  min-width: 3.5rem;
}

.bar-track {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 999px;
  display: block;
  flex: 1;
  height: 0.5rem;
  min-width: 2rem;
  overflow: hidden;
}

.bar-fill {
  background-color: rgb(var(--v-theme-primary));
  border-radius: inherit;
  display: block;
  height: 100%;
}

/*
  The bar is the only element whose meaning could be read as coming from its colour. In forced
  colours it becomes a filled rectangle with a visible border instead, so the comparison still
  works when the theme's primary colour is discarded.
*/
@media (forced-colors: active) {
  .bar-track {
    border: 1px solid CanvasText;
  }

  .bar-fill {
    background-color: Highlight;
  }
}
</style>
