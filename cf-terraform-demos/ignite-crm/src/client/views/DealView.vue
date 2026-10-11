<script setup lang="ts">
/**
 * One deal: fixed outcome and stage, free-text status line, next action, customer links, calls and
 * meetings, and history. Editing happens in a dialog; on a version conflict the dialog stays open
 * with the user's draft intact and offers to load the latest version.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { mdiCalendarPlus, mdiPencil } from '@mdi/js';
import type { UserRef } from '../../shared/api/crm.ts';
import type { CreateActivityInput, Pipeline } from '../../shared/api/sales.ts';
import ActivityForm from '../components/ActivityForm.vue';
import ActivityList from '../components/ActivityList.vue';
import DealForm from '../components/DealForm.vue';
import DealStatusChip from '../components/DealStatusChip.vue';
import HistoryList from '../components/HistoryList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';
import { type DealFormValue, toUpdateDealInput } from '../services/deal-draft.ts';

const props = defineProps<{
  /**
   * Deal id from the route.
   */
  id: string;
}>();

const format = useFormat();
const { can } = useSession();
const detail = useResource((signal) => api.deal(props.id, signal));
const deal = computed(() => detail.data.value?.deal ?? null);

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);

const pipeline = shallowRef<Pipeline | null>(null);
const assignees = shallowRef<UserRef[]>([]);
const editing = ref(false);
const editor = useSubmission({ forbidden: 'Your role does not allow changing deals.' });
const noChanges = ref(false);

/**
 * Open the editor, loading the pipeline and assignees on first use.
 */
async function openEdit(): Promise<void> {
  editor.reset();
  noChanges.value = false;
  const [loadedPipeline, loadedAssignees] = await Promise.all([
    pipeline.value ?? api.pipeline(),
    assignees.value.length > 0 ? assignees.value : api.assignees()
  ]);
  pipeline.value = loadedPipeline;
  assignees.value = loadedAssignees;
  editing.value = true;
}

/**
 * Save only the fields that changed, against the version the user loaded.
 *
 * @param value The form value.
 */
async function save(value: DealFormValue): Promise<void> {
  const current = deal.value;
  if (current === null) {
    return;
  }
  const changes = toUpdateDealInput(current, value);
  if (changes === null) {
    noChanges.value = true;
    editing.value = false;
    return;
  }
  const updated = await editor.run((key) =>
    api.updateDeal(current.id, changes, current.version, key)
  );
  if (updated !== undefined) {
    editing.value = false;
    await detail.load();
  }
}

/**
 * Load the latest version underneath the open editor, keeping the user's draft.
 *
 * The form was created from the old version and keeps its own draft; only the version the next save
 * is compared against moves forward.
 */
async function reloadLatest(): Promise<void> {
  await detail.load();
  editor.conflict.value = false;
  editor.formError.value =
    'The latest version is loaded. Your edits are still in the form; review them and save again.';
}

const logging = ref(false);
const logger = useSubmission({ forbidden: 'Your role does not allow logging activities.' });

/**
 * Open the activity dialog.
 */
function openLog(): void {
  logger.reset();
  logging.value = true;
}

/**
 * Log a call or meeting about this deal.
 *
 * @param input The activity.
 */
async function logActivity(input: CreateActivityInput): Promise<void> {
  const created = await logger.run((key) => api.createActivity(input, key));
  if (created !== undefined) {
    logging.value = false;
    await detail.load();
  }
}
</script>

<template>
  <ResourceState
    :state="detail.state.value"
    :error="detail.error.value"
    :has-data="detail.data.value !== null"
    skeleton="article"
    @retry="detail.load"
  >
    <section v-if="deal && detail.data.value" aria-labelledby="deal-title">
      <v-breadcrumbs
        :items="[{ title: 'Deals', to: { name: 'deals' } }, { title: deal.title }]"
        class="px-0"
      />
      <div class="d-flex flex-wrap align-center ga-2 mb-1">
        <h1 id="deal-title" class="text-h4 flex-grow-1">{{ deal.title }}</h1>
        <template v-if="can('crm.write')">
          <v-btn variant="tonal" :prepend-icon="mdiCalendarPlus" @click="openLog"
            >Log activity</v-btn
          >
          <v-btn color="primary" :prepend-icon="mdiPencil" @click="openEdit">Edit deal</v-btn>
        </template>
      </div>
      <p class="mb-4">
        <DealStatusChip :deal="deal" />
        <span class="text-h6">{{ format.money(deal.amountMinor) }}</span>
      </p>
      <v-alert
        v-if="noChanges"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-4"
        closable
        @click:close="noChanges = false"
        >Nothing changed, so nothing was saved.</v-alert
      >
      <v-row>
        <v-col cols="12" md="7">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Details</h2></v-card-title>
            <v-list density="compact">
              <v-list-item title="Status line" :subtitle="deal.statusLine ?? '—'" />
              <v-list-item title="Next action">
                <template #subtitle>
                  <span v-if="deal.nextActionText"
                    >{{ deal.nextActionText }} · {{ format.date(deal.nextActionDate ?? '') }}</span
                  >
                  <span v-else>None</span>
                </template>
              </v-list-item>
              <v-list-item title="Primary contact">
                <template #subtitle>
                  <router-link :to="{ name: 'contact', params: { id: deal.primaryContact.id } }">{{
                    deal.primaryContact.displayName
                  }}</router-link>
                </template>
              </v-list-item>
              <v-list-item title="Company">
                <template #subtitle>
                  <router-link
                    v-if="deal.company"
                    :to="{ name: 'company', params: { id: deal.company.id } }"
                    >{{ deal.company.name }}</router-link
                  >
                  <span v-else>None</span>
                </template>
              </v-list-item>
              <v-list-item title="Owner" :subtitle="deal.owner.displayName" />
              <v-list-item
                title="Expected close"
                :subtitle="deal.expectedCloseDate ? format.date(deal.expectedCloseDate) : '—'"
              />
              <v-list-item
                v-if="deal.closedAt"
                title="Closed"
                :subtitle="format.dateTime(deal.closedAt)"
              />
            </v-list>
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">Calls and meetings</h2></v-card-title>
            <ActivityList :activities="detail.data.value.activities" />
          </v-card>
        </v-col>
        <v-col cols="12" md="5">
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value.history" />
          </v-card>
        </v-col>
      </v-row>

      <v-dialog v-model="editing" max-width="760" aria-labelledby="deal-form-title" persistent>
        <v-card>
          <v-card-title><h2 id="deal-form-title" class="text-h6">Edit deal</h2></v-card-title>
          <v-card-text>
            <v-alert
              v-if="editor.conflict.value"
              type="warning"
              variant="tonal"
              class="mb-4"
              data-testid="conflict"
            >
              Someone else changed this deal after you opened it. Your edits are kept below.
              <template #append>
                <v-btn variant="text" @click="reloadLatest">Load latest version</v-btn>
              </template>
            </v-alert>
            <DealForm
              v-if="editing && pipeline"
              :deal="deal"
              :stages="pipeline.stages"
              :assignees="assignees"
              :submitting="editor.submitting.value"
              :field-errors="editor.fieldErrors.value"
              :form-error="editor.conflict.value ? null : editor.formError.value"
              @submit="save"
              @cancel="editing = false"
            />
          </v-card-text>
        </v-card>
      </v-dialog>

      <v-dialog v-model="logging" max-width="760" aria-labelledby="activity-form-title">
        <v-card>
          <v-card-title
            ><h2 id="activity-form-title" class="text-h6">Log a call or meeting</h2></v-card-title
          >
          <v-card-text>
            <ActivityForm
              v-if="logging"
              :initial-contacts="[deal.primaryContact]"
              :companies="deal.company ? [deal.company] : []"
              :deals="[{ id: deal.id, title: deal.title }]"
              :initial-company-id="deal.company?.id ?? null"
              :initial-deal-id="deal.id"
              :submitting="logger.submitting.value"
              :field-errors="logger.fieldErrors.value"
              :form-error="logger.formError.value"
              @submit="logActivity"
              @cancel="logging = false"
            />
          </v-card-text>
        </v-card>
      </v-dialog>
    </section>
  </ResourceState>
</template>
