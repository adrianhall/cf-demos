<script setup lang="ts">
import { shallowRef } from 'vue';

/**
 * Properties supplied to the message composer.
 */
interface Props {
  /**
   * Whether there is currently an open connection to send on. Bound to the room store's `canSend`,
   * so the composer disables itself while reconnecting rather than accepting a message that would
   * be thrown away.
   */
  canSend: boolean;
}

/**
 * Events emitted by the message composer.
 */
interface Emits {
  /**
   * Request that a trimmed, non-empty message be sent.
   */
  send: [body: string];
}

defineProps<Props>();
const emit = defineEmits<Emits>();
const draft = shallowRef('');

/**
 * Emit a non-empty message and clear the field.
 *
 * The draft is cleared optimistically rather than on delivery confirmation. That is the right
 * trade-off for a composer: retaining the text until a broadcast returns would make fast typing
 * feel laggy, and a send that fails raises an error the view surfaces immediately. The Worker
 * validates the body independently (see `src/worker/domain/channel-validation.ts`) — the trim here
 * is a convenience, not the enforcement point.
 */
function submit(): void {
  const value = draft.value.trim();
  if (value.length === 0) {
    return;
  }
  emit('send', value);
  draft.value = '';
}
</script>

<template>
  <form class="message-composer" @submit.prevent="submit">
    <v-text-field
      v-model="draft"
      aria-label="Message"
      autocomplete="off"
      :disabled="!canSend"
      hide-details="auto"
      maxlength="2000"
      placeholder="Message this channel"
    />
    <v-btn :disabled="!canSend" color="primary" type="submit">Send</v-btn>
  </form>
</template>

<style scoped>
.message-composer {
  /* The field is taller than the button, so they are centred against each other rather than
     top-aligned. `center` is right here because the composer is always a single row of input —
     unlike the sidebar's add-channel form, where the field can grow a validation hint below it
     and the button should stay pinned to the field's first line. */
  align-items: center;
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
