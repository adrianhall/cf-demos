<script setup lang="ts">
/**
 * One deal: fixed outcome and stage (closed with "Mark won/lost", optionally converting a win into
 * a project in the same transaction), free-text status line, next action, customer links, calls and
 * meetings, and history. Editing happens in a dialog; on a version conflict the dialog stays open
 * with the user's draft intact and offers to load the latest version.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mdiCalendarPlus, mdiFlagCheckered, mdiPencil, mdiRocketLaunch } from '@mdi/js';
import type { UserRef } from '../../shared/api/crm.ts';
import type { CreateActivityInput, Deal, Pipeline } from '../../shared/api/sales.ts';
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
const router = useRouter();
const { can, session } = useSession();
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
/**
 * The deal as it was when the editor opened: the base the user's edits are measured against.
 */
const baseDeal = shallowRef<Deal | null>(null);
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
  baseDeal.value = deal.value;
  editing.value = true;
}

/**
 * Save only the fields the user changed.
 *
 * Changes are measured against the deal _as the editor opened_ ({@link baseDeal}) and sent with the
 * newest loaded version, so after a conflict and "Load latest version" an untouched field keeps the
 * other person's value rather than being reverted by the stale draft.
 *
 * @param value The form value.
 */
async function save(value: DealFormValue): Promise<void> {
  const current = deal.value;
  const base = baseDeal.value ?? current;
  if (current === null || base === null) {
    return;
  }
  const changes = toUpdateDealInput(base, value);
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
 * is checked against moves forward. Edits are still measured against {@link baseDeal}.
 */
async function reloadLatest(): Promise<void> {
  await detail.load();
  editor.conflict.value = false;
  editor.formError.value =
    'The latest version is loaded. Your edits are still in the form; review them and save again.';
}

const converting = ref(false);
const converter = useSubmission({ forbidden: 'Your role does not allow converting deals.' });
const conversion = ref({ name: '', leadId: '', targetDate: '' });
const canConvert = computed(
  () => can('deal.convert') && deal.value?.status === 'won' && deal.value.project === null
);

/**
 * Open the conversion confirmation with defaults from the deal.
 */
async function openConvert(): Promise<void> {
  converter.reset();
  conversion.value = {
    name: deal.value?.title ?? '',
    leadId: session.value?.user.id ?? '',
    targetDate: ''
  };
  if (assignees.value.length === 0) {
    assignees.value = await api.assignees().catch(() => []);
  }
  converting.value = true;
}

/**
 * Convert the deal into one linked project, then open the project.
 *
 * The server does everything in one transaction; on success there is nothing pending to show. A
 * conflict (converted by someone else, reopened, or edited) reloads the deal so the page reflects
 * what actually happened.
 */
async function convert(): Promise<void> {
  const current = deal.value;
  if (current === null) {
    return;
  }
  const project = await converter.run((key) =>
    api.convertDeal(
      current.id,
      {
        ...(conversion.value.name.trim() === '' ? {} : { name: conversion.value.name }),
        ...(conversion.value.leadId === '' ? {} : { leadId: conversion.value.leadId }),
        targetDate: conversion.value.targetDate === '' ? null : conversion.value.targetDate
      },
      current.version,
      key
    )
  );
  if (project !== undefined) {
    converting.value = false;
    await router.push({ name: 'project', params: { id: project.id } });
  } else if (converter.conflict.value || converter.alreadyApplied.value) {
    // Stale version, or converted/reopened by someone else: show the deal as it now is.
    await detail.load();
  }
}

const closing = ref(false);
const closer = useSubmission({ forbidden: 'Your role does not allow closing deals.' });
const outcome = ref<'won' | 'lost'>('won');
const convertOnWin = ref(true);
const canClose = computed(() => can('crm.write') && deal.value?.status === 'pending');
/**
 * Whether the "also convert" option applies: only for a win, and only for roles that may convert.
 */
const conversionOffered = computed(() => outcome.value === 'won' && can('deal.convert'));

/**
 * Open the "Mark won/lost" dialog with its defaults: won, and convert when allowed.
 */
function openClose(): void {
  closer.reset();
  outcome.value = 'won';
  convertOnWin.value = can('deal.convert');
  closing.value = true;
}

/**
 * Close the deal with the chosen outcome.
 *
 * "Won" with conversion is one Data Worker transaction (`markWon`): the deal is won, the project
 * created, and the deal linked together, or nothing changes — the deal is never left won but
 * unconverted by a failure. "Won" alone and "lost" are ordinary versioned deal updates, which also
 * clear the next action and stamp the close time.
 */
async function closeDeal(): Promise<void> {
  const current = deal.value;
  if (current === null) {
    return;
  }
  if (conversionOffered.value && convertOnWin.value) {
    const project = await closer.run((key) =>
      api.convertDeal(current.id, { markWon: true, targetDate: null }, current.version, key)
    );
    if (project !== undefined) {
      closing.value = false;
      await router.push({ name: 'project', params: { id: project.id } });
      return;
    }
  } else {
    const updated = await closer.run((key) =>
      api.updateDeal(current.id, { status: outcome.value }, current.version, key)
    );
    if (updated !== undefined) {
      closing.value = false;
      await detail.load();
      return;
    }
  }
  if (closer.conflict.value || closer.alreadyApplied.value) {
    // Changed, closed, or converted by someone else: show the deal as it now is.
    await detail.load();
  }
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
        <v-btn v-if="canClose" color="secondary" :prepend-icon="mdiFlagCheckered" @click="openClose"
          >Mark won/lost</v-btn
        >
        <v-btn
          v-if="canConvert"
          color="secondary"
          :prepend-icon="mdiRocketLaunch"
          @click="openConvert"
          >Convert to project</v-btn
        >
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
        v-if="deal.project"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-4"
        data-testid="converted"
      >
        Converted into the delivery project
        <router-link :to="{ name: 'project', params: { id: deal.project.id } }">{{
          deal.project.name
        }}</router-link
        >.
      </v-alert>
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

      <v-dialog v-model="closing" max-width="520" aria-labelledby="close-title">
        <v-card>
          <v-card-title><h2 id="close-title" class="text-h6">Mark won/lost</h2></v-card-title>
          <v-card-text>
            <v-alert
              v-if="closer.formError.value"
              type="error"
              variant="tonal"
              role="alert"
              class="mb-4"
              data-testid="close-error"
              >{{
                closer.conflict.value
                  ? 'This deal changed after you opened it. It has been reloaded; review it and try again.'
                  : closer.formError.value
              }}</v-alert
            >
            <v-form novalidate aria-label="Deal outcome" @submit.prevent="closeDeal">
              <v-radio-group v-model="outcome" label="Outcome" data-testid="outcome">
                <v-radio label="Won" value="won" />
                <v-radio label="Lost" value="lost" />
              </v-radio-group>
              <v-checkbox
                :model-value="conversionOffered && convertOnWin"
                :disabled="!conversionOffered"
                label="Also convert to a delivery project"
                :hint="
                  outcome === 'lost'
                    ? 'Only a won deal can become a project.'
                    : can('deal.convert')
                      ? 'The deal is won and the project is created together, or nothing changes.'
                      : 'Your role cannot convert deals; a manager or sales user can do it later.'
                "
                persistent-hint
                data-testid="convert-on-win"
                @update:model-value="(value) => (convertOnWin = value === true)"
              />
              <p class="text-body-2 text-medium-emphasis mt-4">
                Closing a deal clears its next action and records when it closed.
              </p>
              <div class="d-flex justify-end ga-2 mt-4">
                <v-btn variant="text" :disabled="closer.submitting.value" @click="closing = false"
                  >Cancel</v-btn
                >
                <v-btn type="submit" color="primary" :loading="closer.submitting.value"
                  >Submit</v-btn
                >
              </div>
            </v-form>
          </v-card-text>
        </v-card>
      </v-dialog>

      <v-dialog v-model="converting" max-width="560" aria-labelledby="convert-title">
        <v-card>
          <v-card-title
            ><h2 id="convert-title" class="text-h6">Convert to project</h2></v-card-title
          >
          <v-card-text>
            <p class="mb-4">
              This creates one delivery project linked to this deal, its company, and its primary
              contact. It happens all at once: either the project is created and linked, or nothing
              changes. A deal can be converted only once.
            </p>
            <v-alert
              v-if="converter.formError.value"
              type="error"
              variant="tonal"
              role="alert"
              class="mb-4"
              data-testid="convert-error"
              >{{
                converter.conflict.value
                  ? 'This deal changed after you opened it. It has been reloaded; review it and convert again.'
                  : converter.formError.value
              }}</v-alert
            >
            <v-form novalidate aria-label="Conversion options" @submit.prevent="convert">
              <v-text-field
                v-model="conversion.name"
                label="Project name"
                counter="200"
                :error-messages="
                  converter.fieldErrors.value.name ? [converter.fieldErrors.value.name] : []
                "
              />
              <v-select
                v-model="conversion.leadId"
                :items="assignees"
                item-title="displayName"
                item-value="id"
                label="Delivery lead"
                :error-messages="
                  converter.fieldErrors.value.leadId ? [converter.fieldErrors.value.leadId] : []
                "
              />
              <v-text-field
                v-model="conversion.targetDate"
                label="Target date"
                type="date"
                :error-messages="
                  converter.fieldErrors.value.targetDate
                    ? [converter.fieldErrors.value.targetDate]
                    : []
                "
              />
              <div class="d-flex justify-end ga-2 mt-2">
                <v-btn
                  variant="text"
                  :disabled="converter.submitting.value"
                  @click="converting = false"
                  >Cancel</v-btn
                >
                <v-btn type="submit" color="primary" :loading="converter.submitting.value"
                  >Create project</v-btn
                >
              </div>
            </v-form>
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
