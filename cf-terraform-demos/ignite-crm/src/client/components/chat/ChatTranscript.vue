<script setup lang="ts">
import type { UIMessage } from 'ai';
/**
 * The scrolling transcript: the conversation so far, plus the one notice a returning user needs.
 *
 * It is a `log` live region, so a screen-reader user hears the assistant's answer arrive without
 * having to move focus into the panel. New messages are appended, which is what `role="log"`
 * describes, and the view follows the newest message.
 *
 * @fires decide The user's decision on an approval shown in the transcript.
 */
import { nextTick, ref, useTemplateRef, watch } from 'vue';
import { CHAT_SESSION_TTL_HOURS } from '../../../configuration.ts';
import ChatMessage from './ChatMessage.vue';

const props = defineProps<{
  /**
   * The conversation, oldest first.
   */
  messages: readonly UIMessage[];
  /**
   * Whether the session the panel rejoined had expired, which is the only lifecycle event the panel
   * mentions: a returning user would otherwise wonder where their history went.
   */
  expired: boolean;
  /**
   * Whether a turn is waiting for the model's first output.
   */
  pending: boolean;
}>();

const emit = defineEmits<{
  /**
   * The user approved or declined a write.
   */
  decide: [approvalId: string, toolCallId: string, approved: boolean];
}>();

const list = useTemplateRef<HTMLElement>('list');

watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    const element = list.value;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }
);
</script>

<template>
  <div ref="list" class="chat-transcript pa-3" data-testid="chat-transcript">
    <v-alert
      v-if="props.expired"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-3"
      data-testid="chat-expired"
      >This conversation expired after {{ CHAT_SESSION_TTL_HOURS }} hours of inactivity.</v-alert
    >
    <p v-if="props.messages.length === 0" class="text-body-2 text-medium-emphasis">
      Ask about your contacts, deals, projects, or notes. The assistant can only see what your
      access allows, and asks before changing anything.
    </p>
    <!-- The live region and the list are separate elements on purpose: `role="log"` on the `<ul>`
         replaces its list role, which orphans every `<li>` inside it ("List item parent element has
         a role that is not role=list" — caught by the axe pass on the open panel). Wrapping keeps
         both semantics: the region announces, and the list is still a list. -->
    <div role="log" aria-live="polite" aria-label="Conversation">
      <ul class="chat-messages">
        <ChatMessage
          v-for="message in props.messages"
          :key="message.id"
          :message="message"
          @decide="
            (approvalId, toolCallId, approved) => emit('decide', approvalId, toolCallId, approved)
          "
        />
      </ul>
    </div>
    <v-progress-linear
      v-if="props.pending"
      indeterminate
      aria-label="The assistant is thinking"
      data-testid="chat-pending"
    />
  </div>
</template>

<style scoped>
.chat-transcript {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
}

.chat-messages {
  padding: 0;
  margin: 0;
}
</style>
