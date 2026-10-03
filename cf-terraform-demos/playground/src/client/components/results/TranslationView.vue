<script setup lang="ts">
/**
 * Source and translation side by side, line for line, with copy and download.
 *
 * The alignment is the point of this component. The two columns are rendered from the server's
 * aligned segments rather than from two strings split in the browser, so a line in the left column
 * is always the line that produced the one beside it. Re-splitting here would re-introduce exactly
 * the drift that server-side segmentation exists to prevent.
 *
 * It is a real `table`, because this is tabular data: a screen reader announces the column for each
 * cell, which a pair of floated columns cannot do. On a narrow screen the rows stack, which is why
 * each cell carries its own visually-hidden column label — a stacked row with no labels reads as
 * alternating fragments of two languages.
 *
 * The `lang` attribute on every translated cell is what makes this panel usable with a screen
 * reader at all: without it the synthesiser reads Hindi with English pronunciation rules. It is set
 * from the target language code the server reported applying, never from anything the model
 * returned.
 */
import { computed, ref } from 'vue';
import type { Translation } from '../../../shared/translate-text';

const props = defineProps<{
  /**
   * The assembled translation to render.
   */
  translation: Translation;
  /**
   * Language code the source text is in, used for the source column's `lang` attribute.
   */
  sourceLanguage: string;
  /**
   * Language code the translation is in, used for the translated column's `lang` attribute.
   */
  targetLanguage: string;
  /**
   * Human-readable name of the source language, for the column heading.
   */
  sourceLanguageName: string;
  /**
   * Human-readable name of the target language, for the column heading.
   */
  targetLanguageName: string;
  /**
   * Run identifier, used to build a stable download file name.
   */
  runId: string;
}>();

/**
 * Whether the translation has just been copied, so the button can confirm it.
 */
const copied = ref(false);

/**
 * The translation as a downloadable plain-text document.
 *
 * Only the translation, not the source. A visitor downloading this wants the result; the source is
 * text they already have, and interleaving the two would make the file something they then have to
 * edit.
 *
 * @returns The file's contents.
 */
const downloadText = computed(() => props.translation.text);

/**
 * A `data:` URI carrying the downloadable translation.
 *
 * Encoded through `encodeURIComponent` rather than base64, because a naive `btoa` throws on any
 * character outside Latin-1 — which is _every_ target language this panel offers for one of its two
 * models. That would not be an edge case here; it would be the normal path.
 *
 * @returns The download URI.
 */
const downloadUri = computed(
  () => `data:text/plain;charset=utf-8,${encodeURIComponent(downloadText.value)}`
);

/**
 * File name offered when the translation is downloaded.
 *
 * Built from the run identifier and the target language code, never from the translated text: a
 * file name derived from model output is a path-traversal and header-injection surface for no real
 * benefit.
 *
 * @returns The download file name.
 */
const downloadName = computed(() => `translation-${props.targetLanguage}-${props.runId}.txt`);

/**
 * Copies the translation to the clipboard.
 *
 * @returns A promise fulfilled once the copy has been attempted.
 */
async function copyTranslation(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.translation.text);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2_000);
  } catch {
    // A denied or unavailable clipboard is not worth an error banner: the text is on screen and
    // selectable, so the visitor has already got what they need by another route.
    copied.value = false;
  }
}
</script>

<template>
  <div class="translation">
    <div class="header">
      <h3 id="translation-heading" class="heading">Translation</h3>
      <div class="actions">
        <!--
          `aria-live` on the button's own label so the confirmation is announced. A separate live
          region would be announced in addition to the button, which is noisier than the single
          change screen-reader users expect from a copy action.
        -->
        <button type="button" class="action" @click="copyTranslation">
          <span aria-live="polite">{{ copied ? 'Copied' : 'Copy translation' }}</span>
        </button>
        <a class="action" :download="downloadName" :href="downloadUri">Download</a>
      </div>
    </div>

    <div class="table-scroll">
      <table class="pairs">
        <caption class="visually-hidden">
          Each line of the source text beside its translation, in the same order
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ props.sourceLanguageName }}</th>
            <th scope="col">{{ props.targetLanguageName }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(segment, index) in props.translation.segments"
            :key="index"
            :class="{ 'row--blank': segment.blank }"
          >
            <td :lang="props.sourceLanguage">
              <span class="visually-hidden">{{ props.sourceLanguageName }}: </span>
              <!--
                A blank line is rendered as a visible gap rather than as an empty cell with no
                height, so the preserved structure is actually visible. It is announced as such
                too: a screen reader reaching a silent row would have no idea why.
              -->
              <template v-if="segment.blank">
                <span class="visually-hidden">blank line</span>
                <span aria-hidden="true" class="blank-marker">&nbsp;</span>
              </template>
              <template v-else>{{ segment.source }}</template>
            </td>
            <!--
              `lang` on the cell, so a screen reader switches pronunciation for the translated
              text. Without it Hindi is read with English rules, which is unintelligible.
            -->
            <td :lang="props.targetLanguage">
              <span class="visually-hidden">{{ props.targetLanguageName }}: </span>
              <template v-if="segment.blank">
                <span aria-hidden="true" class="blank-marker">&nbsp;</span>
              </template>
              <template v-else>{{ segment.translated }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="facts">
      {{ props.translation.translatedLineCount }}
      {{ props.translation.translatedLineCount === 1 ? 'line' : 'lines' }} translated in
      {{ props.translation.inferenceCallCount }}
      {{ props.translation.inferenceCallCount === 1 ? 'paid request' : 'paid requests' }}.
    </p>
  </div>
</template>

<style scoped>
.translation {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.header {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  justify-content: space-between;
}

.heading {
  font-size: 1rem;
  margin: 0;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.action {
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.35rem;
  color: inherit;
  cursor: pointer;
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.75rem;
  text-decoration: none;
}

.action:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

.table-scroll {
  max-height: 28rem;
  overflow: auto;
}

.pairs {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
}

.pairs th,
.pairs td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  overflow-wrap: anywhere;
  padding: 0.45rem 0.6rem;
  text-align: left;
  vertical-align: top;
  width: 50%;
}

/*
  Sticky so the language names stay visible while scrolling a long passage — otherwise the columns
  become two unlabelled blocks of text a few rows down, which for an unfamiliar script is the
  difference between readable and not.
*/
.pairs thead th {
  background-color: rgb(var(--v-theme-surface));
  position: sticky;
  top: 0;
}

.blank-marker {
  display: inline-block;
  min-height: 1rem;
}

.facts {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0;
}

/*
  Stacked on a narrow screen, which is what the specification asks for. The visually-hidden column
  labels in every cell are what keep a stacked row comprehensible: without them the rows read as
  alternating fragments of two languages with no indication of which is which.
*/
@media (max-width: 40rem) {
  .pairs,
  .pairs tbody,
  .pairs tr,
  .pairs td {
    display: block;
    width: auto;
  }

  .pairs thead {
    display: none;
  }

  .pairs tr {
    border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
    padding: 0.35rem 0;
  }

  .pairs td {
    border-bottom: 0;
    padding: 0.15rem 0;
  }

  /* The translated line is the result, so it carries the emphasis when the pair is stacked. */
  .pairs td:last-child {
    color: rgb(var(--v-theme-on-surface));
    font-weight: 500;
  }

  .pairs td:first-child {
    color: rgb(var(--v-theme-on-surface-variant));
    font-size: 0.875rem;
  }
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
</style>
