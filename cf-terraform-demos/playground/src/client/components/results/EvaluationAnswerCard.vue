<script setup lang="ts">
/**
 * One typed answer, rendered by its type.
 *
 * The component switches on the answer's discriminant rather than on anything about the model, so
 * adding a fourth answer type fails the build here until it is handled.
 *
 * **Confidence is rendered separately from the answer, always.** That is the panel's central claim
 * and the reason this component exists rather than reusing a ranked-label table. A probability says
 * which answer; a confidence says how much to trust it, and the two move independently — verified
 * live, an answer of `0.7111` arrived with confidence `0.1782`. Merging them into one bar, or
 * shading the bar by confidence, would destroy exactly the distinction the panel was built to show.
 * They are therefore different controls, in different places, with different wording.
 *
 * A `noul` answer has **no confidence at all** in the reviewed contract, and the type reflects
 * that, so there is no branch here that could render a zero for it.
 *
 * Nothing is conveyed by bar length or colour alone: every bar sits beside its own number, every
 * score has a sentence naming the legend entries it falls between, and the winning option is marked
 * with a word rather than only a highlight.
 */
import type { EvaluationAnswer } from '../../../shared/evaluate-choices';
import {
  describeConfidence,
  describeNoulStrength,
  describeScorePosition,
  formatProbability,
  probabilityBarWidthPercent,
  scorePositionPercent
} from './evaluation-answers';

const props = defineProps<{
  /**
   * The question name the answer came back under.
   */
  name: string;
  /**
   * What was asked, shown with the answer so a card is readable on its own.
   */
  instructions: string;
  /**
   * The typed answer.
   */
  answer: EvaluationAnswer;
}>();
</script>

<template>
  <article class="answer-card">
    <header class="card-header">
      <h3 class="card-title">{{ props.name }}</h3>
      <span class="card-type">{{ props.answer.type }}</span>
    </header>
    <p class="card-instructions">{{ props.instructions }}</p>

    <!-- A truth-valued judgement: a probability, never a yes/no, and no confidence exists. -->
    <template v-if="props.answer.type === 'noul'">
      <p class="headline">
        <span class="headline-value">{{ formatProbability(props.answer.probability) }}</span>
        <span class="headline-word">{{ describeNoulStrength(props.answer.probability) }}</span>
      </p>
      <span class="bar-track" aria-hidden="true">
        <span
          class="bar-fill"
          :style="{ width: `${probabilityBarWidthPercent(props.answer.probability)}%` }"
        ></span>
      </span>
      <!--
        Stated rather than left as an empty space. A reader who has seen a confidence on the card
        above would otherwise reasonably wonder whether this one was zero.
      -->
      <p class="note">
        This question type returns a probability only. The model reports no separate confidence for
        a yes/no judgement.
      </p>
    </template>

    <!-- A selection: one probability per offered option, in the order they were written. -->
    <template v-else-if="props.answer.type === 'choice'">
      <p class="headline">
        <span class="headline-value">{{ props.answer.choice }}</span>
        <span class="headline-word">selected</span>
      </p>
      <table class="distribution">
        <caption class="visually-hidden">
          Probability for each offered option
        </caption>
        <thead>
          <tr>
            <th scope="col">Option</th>
            <th scope="col" class="value-column">Probability</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in props.answer.probabilities" :key="entry.name">
            <th scope="row" class="option-cell">
              {{ entry.name }}
              <!-- A word, so the winner survives a screen reader and a monochrome display. -->
              <span v-if="entry.selected" class="selected-marker">chosen</span>
            </th>
            <td class="value-column">
              <div class="value-cell">
                <span class="value">{{ formatProbability(entry.probability) }}</span>
                <span class="bar-track" aria-hidden="true">
                  <span
                    class="bar-fill"
                    :class="{ winner: entry.selected }"
                    :style="{ width: `${probabilityBarWidthPercent(entry.probability)}%` }"
                  ></span>
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="confidence">
        <span class="confidence-label">Confidence</span>
        <span class="confidence-value">{{ formatProbability(props.answer.confidence) }}</span>
        <span class="confidence-word">{{ describeConfidence(props.answer.confidence) }}</span>
      </div>
    </template>

    <!-- A graded rating: a continuous position along an ordered legend. -->
    <template v-else>
      <p class="headline">
        <span class="headline-value">{{ props.answer.score.toFixed(2) }}</span>
        <span class="headline-word">on a {{ props.answer.legend.length }}-point legend</span>
      </p>
      <!--
        The sentence is the real result; the gauge below is decoration. Someone who cannot see the
        marker still learns exactly where the score falls.
      -->
      <p class="score-position">
        {{ describeScorePosition(props.answer.score, props.answer.legend) }}
      </p>
      <div class="gauge" aria-hidden="true">
        <span class="gauge-track"></span>
        <span
          class="gauge-marker"
          :style="{
            left: `${scorePositionPercent(props.answer.score, props.answer.legend.length)}%`
          }"
        ></span>
      </div>
      <ol class="legend" aria-hidden="true">
        <li v-for="label in props.answer.legend" :key="label" class="legend-entry">{{ label }}</li>
      </ol>
      <table class="distribution">
        <caption class="visually-hidden">
          Probability for each legend position
        </caption>
        <thead>
          <tr>
            <th scope="col">Legend entry</th>
            <th scope="col" class="value-column">Probability</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in props.answer.probabilities" :key="entry.name">
            <th scope="row" class="option-cell">
              {{ entry.name }}
              <span v-if="entry.selected" class="selected-marker">most likely</span>
            </th>
            <td class="value-column">
              <div class="value-cell">
                <span class="value">{{ formatProbability(entry.probability) }}</span>
                <span class="bar-track" aria-hidden="true">
                  <span
                    class="bar-fill"
                    :class="{ winner: entry.selected }"
                    :style="{ width: `${probabilityBarWidthPercent(entry.probability)}%` }"
                  ></span>
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="confidence">
        <span class="confidence-label">Confidence</span>
        <span class="confidence-value">{{ formatProbability(props.answer.confidence) }}</span>
        <span class="confidence-word">{{ describeConfidence(props.answer.confidence) }}</span>
      </div>
    </template>
  </article>
</template>

<style scoped>
.answer-card {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
  padding: 0.9rem;
}

.card-header {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
}

.card-title {
  font-family: ui-monospace, monospace;
  font-size: 0.9375rem;
  margin: 0;
}

.card-type {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.25rem;
  font-family: ui-monospace, monospace;
  font-size: 0.6875rem;
  padding: 0.05rem 0.35rem;
}

.card-instructions,
.note,
.score-position {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  margin: 0;
}

.headline {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0;
}

.headline-value {
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.headline-word {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}

.distribution {
  border-collapse: collapse;
  width: 100%;
}

.distribution th,
.distribution td {
  padding: 0.3rem 0.5rem 0.3rem 0;
  text-align: left;
  vertical-align: middle;
}

.distribution thead th {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.6875rem;
  font-weight: 600;
}

.option-cell {
  font-size: 0.875rem;
  font-weight: 400;
  overflow-wrap: anywhere;
}

.selected-marker {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 0.25rem;
  color: rgb(var(--v-theme-primary));
  font-size: 0.6875rem;
  font-weight: 600;
  margin-left: 0.35rem;
  padding: 0.05rem 0.3rem;
}

.value-column {
  width: 55%;
}

.value-cell {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.value {
  font-size: 0.875rem;
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
  background-color: rgb(var(--v-theme-secondary));
  border-radius: inherit;
  display: block;
  height: 100%;
}

.bar-fill.winner {
  background-color: rgb(var(--v-theme-primary));
}

/*
  Confidence is visually separated from every probability above it: its own row, its own border,
  its own wording. Nothing about it is drawn in the same idiom as a probability bar, because the
  one thing this card must not imply is that they are the same kind of number.
*/
.confidence {
  align-items: baseline;
  border-top: 1px dashed rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-top: 0.6rem;
}

.confidence-label {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.confidence-value {
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.confidence-word {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.gauge {
  height: 1rem;
  position: relative;
}

.gauge-track {
  background-color: rgb(var(--v-theme-surface-variant));
  border-radius: 999px;
  display: block;
  height: 0.4rem;
  position: absolute;
  top: 0.3rem;
  width: 100%;
}

.gauge-marker {
  background-color: rgb(var(--v-theme-primary));
  border-radius: 50%;
  display: block;
  height: 0.85rem;
  margin-left: -0.425rem;
  position: absolute;
  top: 0.075rem;
  width: 0.85rem;
}

.legend {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.legend-entry {
  color: rgb(var(--v-theme-on-surface-variant));
  flex: 1;
  font-size: 0.6875rem;
  text-align: center;
}

.legend-entry:first-child {
  text-align: left;
}

.legend-entry:last-child {
  text-align: right;
}

.visually-hidden {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

/*
  In forced colours the bars and the gauge marker lose their theme colours, so each gains a border
  or a system colour. Every value they depict is already present as text beside them.
*/
@media (forced-colors: active) {
  .bar-track,
  .gauge-track {
    border: 1px solid CanvasText;
  }

  .bar-fill,
  .gauge-marker {
    background-color: Highlight;
  }
}
</style>
