<script setup lang="ts">
import { ref } from 'vue';
import type { Escalation } from '../../worker/domain/escalation';

/**
 * Inputs from the queue container.
 */
interface Props {
  /**
   * Escalations the server authorized the current actor to see.
   */
  escalations: Escalation[];
  /**
   * Whether an operation is in flight.
   */
  busy: boolean;
}
/**
 * Queue action events.
 */
interface Emits {
  /**
   * Submit a PM answer and optional FAQ publication fields.
   */
  answer: [id: string, answer: string, publishFaq: boolean];
  /**
   * Submit a requester-visible rejection.
   */
  reject: [id: string, reason: string];
  /**
   * Reassign to a different PM display name.
   */
  reassign: [id: string, target: string];
}
const props = defineProps<Props>();
const emit = defineEmits<Emits>();
const answer = ref('');
const rejection = ref('');
const target = ref('');
const publishFaq = ref(false);
/**
 * Submit the focused escalation answer. @param id Escalation identifier. @returns Nothing; emits a
 * typed event.
 */
function submitAnswer(id: string): void {
  emit('answer', id, answer.value, publishFaq.value);
  answer.value = '';
}
/**
 * Submit the focused escalation rejection. @param id Escalation identifier. @returns Nothing; emits
 * a typed event.
 */
function submitReject(id: string): void {
  emit('reject', id, rejection.value);
  rejection.value = '';
}
/**
 * Submit a reassignment. @param id Escalation identifier. @returns Nothing; emits a typed event.
 */
function submitReassign(id: string): void {
  emit('reassign', id, target.value);
  target.value = '';
}
</script>
<template>
  <section class="queue" aria-labelledby="queue-heading">
    <h1 id="queue-heading">Escalation queue</h1>
    <p v-if="props.escalations.length === 0" role="status">
      No escalations are currently in your scope.
    </p>
    <article v-for="item in props.escalations" :key="item.id" class="item">
      <h2>{{ item.currentAssignee ?? 'Unassigned' }}</h2>
      <p>Product: {{ item.productId ?? 'Unclassified' }} · Status: {{ item.status }}</p>
      <form @submit.prevent="submitAnswer(item.id)">
        <label :for="`answer-${item.id}`">Response</label>
        <textarea :id="`answer-${item.id}`" v-model="answer" required :disabled="props.busy" />
        <label
          ><input v-model="publishFaq" type="checkbox" :disabled="props.busy" /> Publish as
          FAQ</label
        >
        <button type="submit" :disabled="props.busy">Send answer</button>
      </form>
      <form @submit.prevent="submitReject(item.id)">
        <label :for="`reject-${item.id}`">Rejection reason</label>
        <input :id="`reject-${item.id}`" v-model="rejection" required :disabled="props.busy" />
        <button type="submit" :disabled="props.busy">Reject</button>
      </form>
      <form @submit.prevent="submitReassign(item.id)">
        <label :for="`target-${item.id}`">Reassign to</label>
        <input :id="`target-${item.id}`" v-model="target" required :disabled="props.busy" />
        <button type="submit" :disabled="props.busy">Reassign</button>
      </form>
    </article>
  </section>
</template>
<style scoped>
.queue,
.item,
form {
  display: grid;
  gap: 0.75rem;
}
.item {
  border: 1px solid #d0d7de;
  padding: 1rem;
}
.item h2,
.item p {
  margin: 0;
}
textarea {
  min-height: 5rem;
}
button,
input,
textarea {
  font: inherit;
  min-height: 2.75rem;
}
</style>
