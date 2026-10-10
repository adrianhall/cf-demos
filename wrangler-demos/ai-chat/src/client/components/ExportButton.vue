<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";
import type { ChatTurn } from "../stores/chat";
import { downloadTextFile } from "../lib/download";
import { buildMarkdownTranscript } from "../lib/transcript";

/** Properties supplied to the export control. */
interface Props {
  /** The conversation to export. */
  turns: ChatTurn[];
}

const props = defineProps<Props>();

/** Build the Markdown transcript and trigger a browser download of it. */
function exportTranscript(): void {
  const content = buildMarkdownTranscript(props.turns);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  downloadTextFile(`ai-chat-transcript-${timestamp}.md`, content);
}
</script>

<template>
  <button
    class="export-button"
    :disabled="turns.length === 0"
    type="button"
    @click="exportTranscript"
  >
    <FeatherIcon aria-hidden="true" size="18" type="download" />
    <span class="ml-2">Export</span>
  </button>
</template>

<style scoped>
.export-button {
  align-items: center;
  background: transparent;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-weight: 600;
  min-height: 2.75rem;
  padding: 0 1rem;
}

.export-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ml-2 {
  margin-left: 0.5rem;
}
</style>
