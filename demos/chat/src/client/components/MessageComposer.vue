<script setup lang="ts">
import { shallowRef } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "vue-feather";

/** Properties supplied to the message composer. */
interface Props {
  /** Whether the room store currently has an open connection to send over. */
  disabled: boolean;
}

/** Events emitted by the message composer. */
interface Emits {
  /** Request that a trimmed, non-empty message be sent over the live connection. */
  send: [body: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
const draft = shallowRef("");

/** Send a non-empty message and clear the composer, matching the scenario's "clears on send". */
function submit(): void {
  const value = draft.value.trim();
  if (value.length === 0) {
    return;
  }
  emit("send", value);
  draft.value = "";
}
</script>

<template>
  <form class="message-composer" @submit.prevent="submit">
    <v-text-field
      v-model="draft"
      aria-label="Message"
      autocomplete="off"
      :disabled="disabled"
      hide-details="auto"
      maxlength="2000"
      placeholder="Message this channel"
    />
    <v-btn :disabled="disabled" color="primary" type="submit">
      <FeatherIcon aria-hidden="true" size="18" type="send" />
      <span class="ml-2">Send</span>
    </v-btn>
  </form>
</template>

<style scoped>
.message-composer {
  align-items: start;
  border-top: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
}

.message-composer .v-text-field {
  flex: 1 1 auto;
}

@media (max-width: 600px) {
  .message-composer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
