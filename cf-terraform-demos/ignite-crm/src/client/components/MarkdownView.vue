<script setup lang="ts">
/**
 * Rendered, read-only Markdown in Vuetify's typography: the reusable surface for showing a note's
 * body (and the composer's preview).
 *
 * Vuetify has no Markdown renderer. This component takes Markdown and nothing else, renders it
 * through `renderMarkdown` — the single security boundary, with HTML disabled and unsafe URLs
 * removed (`src/client/services/markdown.ts`) — and styles the result with theme tokens only, so it
 * reads as part of the same library in light and dark themes. It owns no state and calls no API.
 */
import { computed } from 'vue';
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

const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- The only v-html in the SPA: `html` comes from renderMarkdown, which disables HTML and
       sanitises with DOMPurify. Never bind unsanitised text here. -->
  <div
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
