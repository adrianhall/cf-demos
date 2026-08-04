<script setup lang="ts">
import { computed } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";

/**
 * Export a whole chat as a standalone Markdown document (docs/06-AGENTIC-CHAT.md Phase 12,
 * US-11). Unlike demo 5's `ExportButton.vue` (which builds the Markdown client-side from data
 * already in the browser), this control does no client-side formatting at all: it is a plain
 * anchor pointing at `../../worker/routes/chats.ts`'s `GET /:id/export`, which builds and
 * returns the document server-side (that route's own JSDoc explains why -- this chat's
 * transcript and cost ledger are both durable server-side state). Navigating the anchor reuses
 * the browser's own already-authenticated session exactly like `ChatTranscript.vue`'s
 * attachment-chip download links already do, needing no `fetch()`/`Blob` plumbing of its own.
 */
interface Props {
  /** The currently open chat's id, or `null` before any chat is selected. The control renders
   * disabled with no `href` in that case, since there is then nothing to export. */
  chatId: string | null;
}

const props = defineProps<Props>();

/** The ownership-checked export route, or `null` when no chat is selected. */
const href = computed(() =>
  props.chatId === null
    ? null
    : `/api/chats/${encodeURIComponent(props.chatId)}/export`,
);

/** Block navigation while disabled -- an anchor with no `href` is already unreachable by
 * keyboard/click in most browsers, but this guards the same rare edge case (a direct call, or a
 * browser that renders a bare `<a>` as clickable regardless) `RouteSelector.vue`'s own
 * `disabled` prop guards for a `<select>`. */
function onClick(event: MouseEvent): void {
  if (href.value === null) {
    event.preventDefault();
  }
}
</script>

<template>
  <a
    :aria-disabled="href === null"
    class="export-button"
    :class="{ disabled: href === null }"
    :href="href"
    :tabindex="href === null ? -1 : 0"
    @click="onClick"
  >
    <FeatherIcon aria-hidden="true" size="18" type="download" />
    <span class="ml-2">Export chat</span>
  </a>
</template>

<style scoped>
.export-button {
  align-items: center;
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
  display: inline-flex;
  font-size: 0.8125rem;
  font-weight: 600;
  min-height: 2.25rem;
  padding: 0 0.75rem;
  text-decoration: none;
}

.export-button.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ml-2 {
  margin-left: 0.5rem;
}
</style>
