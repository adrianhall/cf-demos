<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Escalation } from '../../worker/domain/escalation';
import { requestJson } from '../api';
import EscalationQueue from './EscalationQueue.vue';
const escalations = ref<Escalation[]>([]);
const error = ref('');
const status = ref('');
const busy = ref(false);
/**
 * Load only the queue the server authorizes. @returns A promise fulfilled after state is replaced.
 */
async function load(): Promise<void> {
  busy.value = true;
  try {
    escalations.value = (
      await requestJson<{ escalations: Escalation[] }>('/api/escalations')
    ).escalations;
  } catch (reason: unknown) {
    error.value = reason instanceof Error ? reason.message : 'The queue could not be loaded.';
  } finally {
    busy.value = false;
  }
}
/**
 * Answer one escalation. @param id Escalation ID. @param responseText PM response. @param
 * publishFaq Whether to publish it. @returns A promise fulfilled after refresh.
 */
async function answer(id: string, responseText: string, publishFaq: boolean): Promise<void> {
  await act(
    `/api/escalations/${id}/answer`,
    { answer: responseText, publishFaq, ...(publishFaq ? { audience: 'internal' } : {}) },
    'Answer delivered.'
  );
}
/**
 * Reject one escalation. @param id Escalation ID. @param reason Requester-visible reason. @returns
 * A promise fulfilled after refresh.
 */
async function reject(id: string, reason: string): Promise<void> {
  await act(`/api/escalations/${id}/close`, { reason }, 'Rejection delivered.');
}
/**
 * Reassign one escalation. @param id Escalation ID. @param target New PM name. @returns A promise
 * fulfilled after refresh.
 */
async function reassign(id: string, target: string): Promise<void> {
  await act(`/api/escalations/${id}/reassign`, { target }, 'Escalation reassigned.');
}
/**
 * Run a mutation and refresh the authorized queue. @param path API endpoint. @param body JSON body.
 *
 * @param success Live-region status. @returns A promise fulfilled after completion.
 */
async function act(path: string, body: object, success: string): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await requestJson(path, { method: 'POST', body });
    status.value = success;
    await load();
  } catch (reason: unknown) {
    error.value = reason instanceof Error ? reason.message : 'The action could not be completed.';
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
});
</script>
<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p role="status">{{ status }}</p>
  <EscalationQueue
    :escalations="escalations"
    :busy="busy"
    @answer="answer"
    @reject="reject"
    @reassign="reassign"
  />
</template>
<style scoped>
.error {
  color: #b42318;
  font-weight: 600;
}
</style>
