<script setup lang="ts">
/**
 * The chat composer: a multi-line input and Send.
 *
 * `Enter` sends and `Shift+Enter` inserts a newline, which is what a chat input is expected to do;
 * the Send button stays present for pointer and assistive-technology users rather than leaving the
 * keyboard shortcut as the only way to submit.
 *
 * The composer owns only its draft. Whether a turn may start at all is the parent's business, so
 * `disabled` comes in as a prop rather than being inferred here.
 *
 * @fires send The trimmed message text, when the user submits a non-empty draft.
 * @fires stop A request to stop the turn in progress.
 */
import { computed, ref } from 'vue';
import { mdiSend, mdiStop } from '@mdi/js';

const props = defineProps<{
  /**
   * Whether sending is currently impossible (the session is connecting or has failed).
   */
  disabled: boolean;
  /**
   * Whether a turn is in progress, which replaces Send with Stop.
   */
  busy: boolean;
}>();

const emit = defineEmits<{
  /**
   * The user submitted a message.
   */
  send: [text: string];
  /**
   * The user asked to stop the turn in progress.
   */
  stop: [];
}>();

const draft = ref('');

/**
 * Whether the current draft can be sent.
 */
const sendable = computed(() => !props.disabled && !props.busy && draft.value.trim() !== '');

/**
 * Send the draft and clear it.
 */
function submit(): void {
  if (!sendable.value) {
    return;
  }
  emit('send', draft.value.trim());
  draft.value = '';
}
</script>

<template>
  <v-form class="pa-3" aria-label="Ask the assistant" novalidate @submit.prevent="submit">
    <v-textarea
      v-model="draft"
      label="Message"
      placeholder="Ask about your CRM…"
      rows="2"
      max-rows="6"
      auto-grow
      hide-details
      density="compact"
      variant="outlined"
      :disabled="props.disabled"
      data-testid="chat-input"
      @keydown.enter.exact.prevent="submit"
    />
    <div class="d-flex justify-end ga-2 mt-2">
      <v-btn
        v-if="props.busy"
        variant="tonal"
        :prepend-icon="mdiStop"
        data-testid="chat-stop"
        @click="emit('stop')"
        >Stop</v-btn
      >
      <v-btn
        v-else
        type="submit"
        color="primary"
        variant="flat"
        :prepend-icon="mdiSend"
        :disabled="!sendable"
        data-testid="chat-send"
        >Send</v-btn
      >
    </div>
  </v-form>
</template>
