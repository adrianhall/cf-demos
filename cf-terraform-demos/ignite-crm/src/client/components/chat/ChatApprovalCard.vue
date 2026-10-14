<script setup lang="ts">
/**
 * The approval card for one pending write.
 *
 * Every mutating tool pauses here, without exception, so the rule is explainable in one sentence:
 * the assistant never changes anything you have not seen and agreed to
 * (`specs/ignite-crm/05-ai-features.md` §3.5). The card therefore has to state _what_ will happen
 * in words, and show the arguments the assistant proposed, before either button is reachable.
 *
 * Declining is not the same as failing: the parent reports it to the model as a declined action, so
 * the assistant says it was declined rather than apologising for an error.
 *
 * @fires decide The user's decision for this approval.
 */
import { computed } from 'vue';
import { mdiCheck, mdiClose } from '@mdi/js';
import { describePendingWrite } from '../../services/chat-transcript.ts';

const props = defineProps<{
  /**
   * Approval identifier from the tool part.
   */
  approvalId: string;
  /**
   * Tool call the approval belongs to.
   */
  toolCallId: string;
  /**
   * The mutating tool's protocol name.
   */
  toolName: string;
  /**
   * The arguments the assistant proposed.
   */
  input: unknown;
  /**
   * Whether the decision has already been made, which leaves the card in place as a record of what
   * was asked without offering the buttons again.
   */
  decided: boolean;
  /**
   * The decision, when one has been made.
   */
  approved?: boolean;
}>();

const emit = defineEmits<{
  /**
   * The user approved or declined the write.
   */
  decide: [approvalId: string, toolCallId: string, approved: boolean];
}>();

/**
 * What this write will do, in words.
 */
const summary = computed(() => describePendingWrite(props.toolName));

/**
 * The proposed arguments as readable lines.
 *
 * The idempotency key is deliberately absent: it is derived by the server and is plumbing rather
 * than something the user is being asked to agree to.
 */
const details = computed(() => {
  const input = props.input;
  if (typeof input !== 'object' || input === null) {
    return [] as { key: string; value: string }[];
  }
  return Object.entries(input as Record<string, unknown>)
    .filter(([key]) => key !== 'idempotencyKey')
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    }));
});

/**
 * The outcome line shown once a decision has been made.
 */
const outcome = computed(() =>
  props.approved === true ? 'You approved this.' : 'You declined this.'
);
</script>

<template>
  <v-card
    variant="tonal"
    color="primary"
    class="my-2"
    role="group"
    :aria-label="`Approval required: ${summary}`"
    data-testid="chat-approval"
  >
    <v-card-title class="text-subtitle-2">{{ summary }}</v-card-title>
    <v-card-text class="pt-0">
      <dl v-if="details.length > 0" class="approval-details text-body-2">
        <template v-for="detail in details" :key="detail.key">
          <dt class="text-medium-emphasis">{{ detail.key }}</dt>
          <dd>{{ detail.value }}</dd>
        </template>
      </dl>
      <p v-if="props.decided" class="text-body-2 mt-2" data-testid="chat-approval-outcome">
        {{ outcome }}
      </p>
    </v-card-text>
    <v-card-actions v-if="!props.decided">
      <v-spacer />
      <v-btn
        variant="text"
        :prepend-icon="mdiClose"
        data-testid="chat-decline"
        @click="emit('decide', props.approvalId, props.toolCallId, false)"
        >Decline</v-btn
      >
      <v-btn
        variant="flat"
        color="primary"
        :prepend-icon="mdiCheck"
        data-testid="chat-approve"
        @click="emit('decide', props.approvalId, props.toolCallId, true)"
        >Approve</v-btn
      >
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.approval-details {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 12px;
  row-gap: 2px;
  margin: 0;
  overflow-wrap: anywhere;
}

.approval-details dd {
  margin: 0;
}
</style>
