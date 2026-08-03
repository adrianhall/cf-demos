<script setup lang="ts">
import type { ChatRoute } from "../stores/chats";

/** Properties supplied to the route selector (docs/06-AGENTIC-CHAT.md Phase 4, US-3). */
interface Props {
  /** The chat's currently selected route. */
  route: ChatRoute;
  /** `true` once this chat has at least one turn -- US-3's "selectable only when a chat has no
   * turns yet" affordance. Checked client-side from `chat.turns.length > 0` the moment a turn is
   * submitted (before the server's own `title IS NULL` guard would even reject a late change),
   * so the control visibly locks before a rejected request could ever happen in ordinary use. */
  disabled: boolean;
}

/** Events emitted by the route selector. */
interface Emits {
  /** Request a different route for this chat. */
  change: [route: ChatRoute];
}

defineProps<Props>();
const emit = defineEmits<Emits>();

/** Forward the native `<select>`'s chosen value as a typed {@link ChatRoute}. */
function onChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "basic" || value === "reasoning") {
    emit("change", value);
  }
}
</script>

<template>
  <div class="route-selector">
    <label class="route-label" for="route-select">Mode</label>
    <select
      id="route-select"
      :disabled="disabled"
      :value="route"
      @change="onChange"
    >
      <option value="basic">Basic</option>
      <option value="reasoning">Reasoning</option>
    </select>
  </div>
</template>

<style scoped>
.route-selector {
  align-items: center;
  display: flex;
  gap: 0.5rem;
}

.route-label {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
  font-weight: 600;
}

select {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 0.375rem;
  color: rgb(var(--v-theme-on-surface));
  font: inherit;
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
}

select:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
