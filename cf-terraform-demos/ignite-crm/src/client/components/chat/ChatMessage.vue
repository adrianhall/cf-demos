<script setup lang="ts">
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
/**
 * One message in the transcript, rendered part by part.
 *
 * A message is not a string: the AI SDK represents it as ordered parts — text, tool calls, approval
 * requests — and rendering them in order is what makes a turn readable ("looked up the company,
 * then answered"). Assistant text goes through the SPA's existing `MarkdownView` pipeline, so
 * sanitisation and the link policy are already solved and this component adds no second renderer.
 *
 * @fires decide The user's decision on an approval shown inside this message.
 */
import { computed } from 'vue';
import { describeToolActivity } from '../../services/chat-transcript.ts';
import MarkdownView from '../MarkdownView.vue';
import ChatApprovalCard from './ChatApprovalCard.vue';

const props = defineProps<{
  /**
   * The message to render.
   */
  message: UIMessage;
}>();

const emit = defineEmits<{
  /**
   * The user approved or declined a write proposed in this message.
   */
  decide: [approvalId: string, toolCallId: string, approved: boolean];
}>();

/**
 * Tool part states that mean the call is over, one way or another.
 */
const FINISHED = new Set(['output-available', 'output-error', 'output-denied']);

/**
 * Tool part states that are waiting for, or recording, a decision.
 */
const APPROVAL_STATES = new Set(['approval-requested', 'approval-responded', 'output-denied']);

/**
 * Whether this is the user's own message, which is shown as a bubble rather than as prose.
 */
const isUser = computed(() => props.message.role === 'user');

/**
 * The message's parts, in order, reduced to what the transcript renders. Keys are stable per part
 * so a streaming update patches rather than replaces the rendered list.
 */
const parts = computed(() =>
  props.message.parts.flatMap((part, index) => {
    if (part.type === 'text') {
      return [{ kind: 'text' as const, key: `text-${index}`, text: part.text }];
    }
    if (!isToolUIPart(part)) {
      return [];
    }
    const name = getToolName(part);
    if (APPROVAL_STATES.has(part.state) && part.approval !== undefined) {
      return [
        {
          kind: 'approval' as const,
          key: `approval-${part.toolCallId}`,
          toolName: name,
          toolCallId: part.toolCallId,
          approvalId: part.approval.id,
          input: part.input,
          decided: part.state !== 'approval-requested',
          approved: part.approval.approved === true
        }
      ];
    }
    return [
      {
        kind: 'activity' as const,
        key: `tool-${part.toolCallId}`,
        label: describeToolActivity(name, FINISHED.has(part.state)),
        running: !FINISHED.has(part.state)
      }
    ];
  })
);
</script>

<template>
  <li
    class="chat-message"
    :data-role="props.message.role"
    :data-testid="`chat-message-${props.message.role}`"
  >
    <template v-for="part in parts" :key="part.key">
      <p v-if="part.kind === 'text' && isUser" class="chat-bubble text-body-2">{{ part.text }}</p>
      <MarkdownView
        v-else-if="part.kind === 'text'"
        :source="part.text"
        label="Assistant answer"
        class="mb-2"
      />
      <ChatApprovalCard
        v-else-if="part.kind === 'approval'"
        :approval-id="part.approvalId"
        :tool-call-id="part.toolCallId"
        :tool-name="part.toolName"
        :input="part.input"
        :decided="part.decided"
        :approved="part.approved"
        @decide="
          (approvalId, toolCallId, approved) => emit('decide', approvalId, toolCallId, approved)
        "
      />
      <p v-else class="chat-activity text-caption text-medium-emphasis" data-testid="chat-activity">
        {{ part.label }}{{ part.running ? '…' : '' }}
      </p>
    </template>
  </li>
</template>

<style scoped>
.chat-message {
  list-style: none;
  margin-bottom: 12px;
  min-width: 0;
}

.chat-message[data-role='user'] {
  display: flex;
  justify-content: flex-end;
}

.chat-bubble {
  background: rgba(var(--v-theme-primary), 0.12);
  border-radius: 12px;
  padding: 8px 12px;
  margin: 0;
  max-width: 85%;
  overflow-wrap: anywhere;
}

.chat-activity {
  margin: 0 0 8px;
}
</style>
