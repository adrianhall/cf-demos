<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../lib/markdown";

/**
 * Render a Markdown document as sanitized HTML (`../lib/markdown.ts`) -- the one place in this
 * demo's client that uses `v-html`, per Vue's own template-safety guidance to isolate that
 * pattern behind a single, obviously-reviewed component rather than scattering `v-html` bindings
 * across every view that happens to need Markdown. Used by `ReviewReport.vue` to render a run's
 * full report (`../../worker/review/report.ts`'s `buildFullReport()`).
 */
interface Props {
  /** The raw Markdown source to render. */
  markdown: string;
}

const props = defineProps<Props>();

/** Sanitized HTML -- `renderMarkdown()` itself is the actual security boundary here (see that
 * module's own doc comment); this component trusts its output because it, not caller-supplied
 * text, is what `v-html` ever binds to. */
const html = computed(() => renderMarkdown(props.markdown));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-view" v-html="html" />
</template>

<style scoped>
.markdown-view :deep(table) {
  border-collapse: collapse;
  margin-block: 1rem;
  width: 100%;
}

.markdown-view :deep(th),
.markdown-view :deep(td) {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.5rem;
  text-align: left;
}

.markdown-view :deep(details) {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.25rem;
  margin-block: 0.5rem;
  padding: 0.5rem 0.75rem;
}

.markdown-view :deep(summary) {
  cursor: pointer;
  font-weight: 600;
}
</style>
