<script setup lang="ts">
/**
 * Rendered, read-only Markdown in Vuetify's typography: the reusable surface for showing a note's
 * body (and the composer's preview).
 *
 * Vuetify has no Markdown renderer. This component takes Markdown and nothing else, renders it
 * through `renderMarkdown` — the single security boundary, with HTML disabled and unsafe URLs
 * removed (`src/client/services/markdown.ts`) — and styles the result with theme tokens only, so it
 * reads as part of the same library in light and dark themes. It owns no state beyond the render
 * and calls no API.
 *
 * The renderer arrives in its own lazily loaded chunk, so the first render is asynchronous. While
 * it loads, the region is `aria-busy` and shows a Vuetify text skeleton; if the chunk cannot be
 * fetched, an alert offers a retry instead of showing raw, unsanitised text. Renders are
 * generation-counted so a slow earlier render can never overwrite a newer source.
 */
import { ref, shallowRef, watch } from 'vue';
import { renderMarkdown } from '../services/markdown.ts';

const props = defineProps<{
  /**
   * Raw Markdown source.
   */
  source: string;
  /**
   * Accessible name of the rendered region (for example, the note title).
   */
  label: string;
}>();

const html = shallowRef<string | null>(null);
const failed = ref(false);
let generation = 0;

/**
 * Render the current source, ignoring results that a newer render has superseded.
 */
async function render(): Promise<void> {
  const current = ++generation;
  failed.value = false;
  try {
    const rendered = await renderMarkdown(props.source);
    if (current === generation) {
      html.value = rendered;
    }
  } catch {
    if (current === generation) {
      failed.value = true;
    }
  }
}

watch(() => props.source, render, { immediate: true });
</script>

<template>
  <v-alert v-if="failed" type="warning" variant="tonal" role="alert" data-testid="markdown-error">
    The note could not be displayed because part of the app failed to load.
    <template #append>
      <v-btn variant="text" @click="render">Retry</v-btn>
    </template>
  </v-alert>
  <div
    v-else-if="html === null"
    role="region"
    :aria-label="props.label"
    aria-busy="true"
    data-testid="markdown-loading"
  >
    <v-skeleton-loader type="paragraph" aria-label="Loading note text" />
  </div>
  <!-- The only v-html in the SPA: `html` comes from renderMarkdown, which disables HTML and
       sanitises with DOMPurify. Never bind unsanitised text here. -->
  <div
    v-else
    class="markdown-view text-body-1"
    role="region"
    :aria-label="props.label"
    data-testid="markdown-view"
    v-html="html"
  ></div>
</template>

<style scoped>
.markdown-view {
  overflow-wrap: anywhere;
  min-width: 0;
}

.markdown-view :deep(> :first-child) {
  margin-top: 0;
}

.markdown-view :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown-view :deep(p),
.markdown-view :deep(ul),
.markdown-view :deep(ol),
.markdown-view :deep(pre),
.markdown-view :deep(blockquote),
.markdown-view :deep(table) {
  margin-block: 0 12px;
}

.markdown-view :deep(ul),
.markdown-view :deep(ol) {
  padding-inline-start: 24px;
}

.markdown-view :deep(li:has(> input[type='checkbox'])) {
  list-style: none;
  margin-inline-start: -20px;
}

.markdown-view :deep(input[type='checkbox']) {
  margin-inline-end: 8px;
  accent-color: rgb(var(--v-theme-primary-strong));
}

.markdown-view :deep(h3),
.markdown-view :deep(h4),
.markdown-view :deep(h5),
.markdown-view :deep(h6) {
  font-weight: 500;
  line-height: 1.4;
  margin-block: 16px 8px;
}

.markdown-view :deep(h3) {
  font-size: 1.25rem;
}

.markdown-view :deep(h4) {
  font-size: 1.125rem;
}

.markdown-view :deep(a) {
  color: rgb(var(--v-theme-primary-strong));
  text-decoration: underline;
}

.markdown-view :deep(a:focus-visible) {
  outline: 2px solid rgb(var(--v-theme-primary-strong));
  outline-offset: 2px;
}

.markdown-view :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875em;
  background: rgba(var(--v-theme-on-surface), 0.06);
  border-radius: 4px;
  padding: 0.1em 0.3em;
}

.markdown-view :deep(pre) {
  background: rgba(var(--v-theme-on-surface), 0.06);
  border-radius: 4px;
  padding: 12px;
  overflow-x: auto;
}

.markdown-view :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-view :deep(blockquote) {
  border-inline-start: 4px solid rgba(var(--v-theme-on-surface), 0.2);
  padding-inline-start: 12px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.markdown-view :deep(table) {
  border-collapse: collapse;
}

.markdown-view :deep(th),
.markdown-view :deep(td) {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 4px 8px;
}
</style>
