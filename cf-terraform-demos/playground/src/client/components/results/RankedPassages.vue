<script setup lang="ts">
/**
 * A ranked search result: passages ordered by relevance, with their scores and cache state.
 *
 * Deliberately a separate component from {@link RankedLabels} rather than a reuse of it, despite the
 * similar layout. Three things differ, and all three are about not overstating what a similarity
 * is: the number is shown as a bare decimal rather than a percentage, the row is identified by the
 * passage's own text rather than by a short label, and a per-row cache marker carries cost
 * information that a classifier's ranking has no equivalent of.
 *
 * It is a real `table` because the data genuinely is tabular — rank, passage, score — and a table
 * gives a screen-reader user row and column context, and a count of rows, for free. The bar lives
 * inside the score cell beside the number rather than replacing it, so nothing here is conveyed by
 * bar length or colour alone and removing every bar would lose no information at all.
 */
import type { RankedPassage } from '../../../shared/semantic-search';
import { formatSimilarity, similarityBarWidthPercent } from './ranked-passages';

const props = defineProps<{
  /**
   * The ranked passages, best first.
   */
  rankings: readonly RankedPassage[];
  /**
   * The collection the rankings refer to, as it was when the search ran.
   *
   * A ranking identifies a passage by its index, so this must be the snapshot the search was
   * produced against rather than the live editor contents — otherwise an edit would silently
   * re-label every row.
   */
  passages: readonly string[];
  /**
   * Accessible caption describing what was ranked, rendered as the table's visible caption.
   */
  caption: string;
  /**
   * Whether to show the per-row cache marker.
   *
   * Hidden for a cross-encoder, which caches nothing: a column of "no" against every row would
   * imply a cache miss where there is no cache to miss.
   */
  showCacheState: boolean;
}>();

/**
 * Reads the text of one ranked passage.
 *
 * @param index Position of the passage in the searched collection.
 * @returns The passage text, or a placeholder when the index is out of range.
 */
function passageText(index: number): string {
  return props.passages[index] ?? '(passage no longer available)';
}
</script>

<template>
  <table class="ranked-passages">
    <caption class="caption">
      {{
        props.caption
      }}
    </caption>
    <thead>
      <tr>
        <th scope="col" class="rank-column">Rank</th>
        <th scope="col">Passage</th>
        <th v-if="props.showCacheState" scope="col" class="cache-column">Embedding</th>
        <th scope="col" class="score-column">Relevance</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in props.rankings" :key="entry.index" class="row">
        <td class="rank-column">{{ entry.rank }}</td>
        <!--
          `th` with `scope="row"`: the passage is what identifies the row, so a screen reader
          announces it alongside the score instead of reading a bare number.
        -->
        <th scope="row" class="passage-cell">{{ passageText(entry.index) }}</th>
        <td v-if="props.showCacheState" class="cache-column">
          <!--
            Words rather than an icon or a colour. "Reused" and "New" are the two cost states and
            both must survive a screen reader, a monochrome display, and forced colours.
          -->
          <span class="cache-state" :class="{ reused: entry.cached }">
            {{ entry.cached ? 'Reused' : 'New' }}
          </span>
        </td>
        <td class="score-column">
          <div class="score">
            <span class="score-value">{{ formatSimilarity(entry.score) }}</span>
            <!--
              `aria-hidden` because the number beside it already says this, and an announced bar
              would read the same value twice. The bar is a visual aid to comparison, not a
              carrier of information.
            -->
            <span class="bar-track" aria-hidden="true">
              <span
                class="bar-fill"
                :style="{ width: `${similarityBarWidthPercent(entry.score)}%` }"
              ></span>
            </span>
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.ranked-passages {
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
  vertical-align: top;
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

.cache-column {
  width: 6rem;
}

/*
  Narrower than the classifier's score column: a passage needs the width far more than a bar does,
  and the bars here are a secondary comparison rather than the main reading.
*/
.score-column {
  padding-right: 0;
  width: 30%;
}

.passage-cell {
  font-weight: 400;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cache-state {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

/*
  A reused embedding is the free one, so it is the state worth drawing attention to. Weight and
  colour together, never colour alone.
*/
.cache-state.reused {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}

.score {
  align-items: center;
  display: flex;
  gap: 0.6rem;
}

/*
  `font-variant-numeric: tabular-nums` so the scores line up vertically; proportional digits make a
  column of numbers ragged and harder to compare, which is the one job this column has.
*/
.score-value {
  font-variant-numeric: tabular-nums;
  min-width: 3rem;
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
