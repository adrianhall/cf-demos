<script setup lang="ts">
/**
 * The action stream: the signed-in user's contact and deal next actions in priority order, grouped
 * by urgency, with keyboard-operable "Done" for contact actions.
 */
import { computed, onMounted, ref } from 'vue';
import type { ActionItem, Urgency } from '../../shared/api/sales.ts';
import ActionStreamRow from '../components/ActionStreamRow.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { api, ApiError, newIdempotencyKey } from '../services/api-client.ts';

const { can } = useSession();
const format = useFormat();
const stream = useResource((signal) => api.actionStream(signal));

/**
 * Section headings in priority order.
 */
const SECTIONS: readonly { urgency: Urgency; title: string }[] = [
  { urgency: 'asap', title: 'As soon as possible' },
  { urgency: 'overdue', title: 'Overdue' },
  { urgency: 'today', title: 'Due today' },
  { urgency: 'upcoming', title: 'Upcoming' }
];

const sections = computed(() =>
  SECTIONS.map((section) => ({
    ...section,
    items: (stream.data.value?.items ?? []).filter((item) => item.urgency === section.urgency)
  })).filter((section) => section.items.length > 0)
);

const busyId = ref<string | null>(null);
const actionError = ref<string | null>(null);

/**
 * Complete a contact action. The stream row carries no version, so the current one is read from the
 * contact first; a concurrent change then surfaces as a conflict rather than completing the wrong
 * action.
 *
 * @param item The row.
 */
async function complete(item: ActionItem): Promise<void> {
  busyId.value = item.id;
  actionError.value = null;
  try {
    const contact = await api.contact(item.contact.id);
    if (contact.nextAction === null || contact.nextAction.id !== item.id) {
      actionError.value = 'That action has already changed. The list has been refreshed.';
    } else {
      await api.completeNextAction(
        item.contact.id,
        contact.nextAction.version,
        newIdempotencyKey()
      );
    }
  } catch (caught) {
    actionError.value = caught instanceof ApiError ? caught.message : 'Could not complete it.';
  } finally {
    busyId.value = null;
    await stream.load();
  }
}

onMounted(() => void stream.load());
</script>

<template>
  <section aria-labelledby="actions-title">
    <h1 id="actions-title" class="text-h4 mb-1">Action stream</h1>
    <p class="text-medium-emphasis mb-4">
      Your next actions on contacts and deals<template v-if="stream.data.value">
        · today is {{ format.date(stream.data.value.today) }}</template
      >
    </p>
    <v-alert
      v-if="actionError"
      type="warning"
      variant="tonal"
      role="alert"
      class="mb-4"
      closable
      @click:close="actionError = null"
      >{{ actionError }}</v-alert
    >
    <ResourceState
      :state="stream.state.value"
      :error="stream.error.value"
      :empty="(stream.data.value?.items.length ?? 0) === 0"
      :has-data="stream.data.value !== null"
      empty-title="Nothing to chase"
      empty-text="Set a next action on a contact or deal and it will appear here."
      @retry="stream.load"
    >
      <v-card v-for="section in sections" :key="section.urgency" class="mb-4">
        <v-card-title>
          <h2 class="text-h6">{{ section.title }} ({{ section.items.length }})</h2>
        </v-card-title>
        <v-list :aria-label="section.title">
          <ActionStreamRow
            v-for="item in section.items"
            :key="`${item.kind}-${item.id}`"
            :item="item"
            :completable="can('crm.write')"
            :busy="busyId === item.id"
            @complete="complete"
          />
        </v-list>
      </v-card>
    </ResourceState>
  </section>
</template>
