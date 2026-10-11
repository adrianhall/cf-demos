<script setup lang="ts">
/**
 * One contact's customer overview: details, next action, deals, delivery projects, calls and
 * meetings, linked notes, a merged timeline, and history, with actions to create a deal for this
 * contact and to log an activity with them.
 *
 * The page makes one composite request (`GET /contacts/:id/overview`). If only the notes section
 * could not be loaded, the server says so explicitly and the Notes card shows that warning with a
 * retry, while everything else renders normally.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { mdiCalendarPlus, mdiPlus } from '@mdi/js';
import type { UserRef } from '../../shared/api/crm.ts';
import type { CreateActivityInput, Pipeline } from '../../shared/api/sales.ts';
import ActivityForm from '../components/ActivityForm.vue';
import ActivityList from '../components/ActivityList.vue';
import CustomerTimeline from '../components/CustomerTimeline.vue';
import DealForm from '../components/DealForm.vue';
import DealList from '../components/DealList.vue';
import HistoryList from '../components/HistoryList.vue';
import NextActionCard from '../components/NextActionCard.vue';
import NotesCard from '../components/NotesCard.vue';
import ProjectList from '../components/ProjectList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';
import { type DealFormValue, toCreateDealInput } from '../services/deal-draft.ts';

const props = defineProps<{
  /**
   * Contact id from the route.
   */
  id: string;
}>();

const router = useRouter();
const format = useFormat();
const { can, session } = useSession();
const overview = useResource((signal) => api.contactOverview(props.id, signal));
const detail = {
  ...overview,
  data: computed(() => overview.data.value?.detail ?? null)
};
const contact = computed(() => detail.data.value?.contact ?? null);
const notesWarning = computed(
  () => overview.data.value?.warnings.find((warning) => warning.section === 'notes') ?? null
);
const picked = computed(() =>
  contact.value === null
    ? null
    : {
        id: contact.value.id,
        displayName: contact.value.displayName,
        companyId: contact.value.company?.id ?? null
      }
);

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);

const pipeline = shallowRef<Pipeline | null>(null);
const assignees = shallowRef<UserRef[]>([]);
const creating = ref(false);
const creator = useSubmission({ forbidden: 'Your role does not allow creating deals.' });

/**
 * Open the create-deal dialog for this contact.
 */
async function openCreateDeal(): Promise<void> {
  creator.reset();
  const [loadedPipeline, loadedAssignees] = await Promise.all([
    pipeline.value ?? api.pipeline(),
    assignees.value.length > 0 ? assignees.value : api.assignees()
  ]);
  pipeline.value = loadedPipeline;
  assignees.value = loadedAssignees;
  creating.value = true;
}

/**
 * Create the deal and open it.
 *
 * @param value The form value.
 */
async function createDeal(value: DealFormValue): Promise<void> {
  const deal = await creator.run((key) =>
    api.createDeal(toCreateDealInput(value, session.value?.user.id ?? ''), key)
  );
  if (deal !== undefined) {
    creating.value = false;
    await router.push({ name: 'deal', params: { id: deal.id } });
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
 * Log the activity and refresh the timeline.
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
    :has-data="overview.data.value !== null"
    skeleton="article"
    @retry="detail.load"
  >
    <section v-if="contact && detail.data.value" aria-labelledby="contact-title">
      <v-breadcrumbs
        :items="[{ title: 'Contacts', to: { name: 'contacts' } }, { title: contact.displayName }]"
        class="px-0"
      />
      <div class="d-flex flex-wrap align-center ga-2 mb-1">
        <h1 id="contact-title" class="text-h4 flex-grow-1">{{ contact.displayName }}</h1>
        <template v-if="can('crm.write')">
          <v-btn variant="tonal" :prepend-icon="mdiCalendarPlus" @click="openLog"
            >Log activity</v-btn
          >
          <v-btn color="primary" :prepend-icon="mdiPlus" @click="openCreateDeal">New deal</v-btn>
        </template>
      </div>
      <p class="text-medium-emphasis mb-4">{{ contact.jobTitle ?? 'No job title' }}</p>
      <v-row>
        <v-col cols="12" md="7">
          <NextActionCard
            class="mb-4"
            :contact-id="contact.id"
            :action="detail.data.value.nextAction"
            :editable="can('crm.write')"
            @changed="detail.load"
          />
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Deals</h2></v-card-title>
            <DealList
              :deals="detail.data.value.deals"
              empty-text="No deals with this contact yet."
            />
          </v-card>
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Projects</h2></v-card-title>
            <ProjectList
              :projects="detail.data.value.projects"
              empty-text="No delivery projects for this contact yet."
            />
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">Calls and meetings</h2></v-card-title>
            <ActivityList :activities="detail.data.value.activities" />
          </v-card>
        </v-col>
        <v-col cols="12" md="5">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Details</h2></v-card-title>
            <v-list density="compact">
              <v-list-item title="Company">
                <template #subtitle>
                  <router-link
                    v-if="contact.company"
                    :to="{ name: 'company', params: { id: contact.company.id } }"
                  >
                    {{ contact.company.name }}
                  </router-link>
                  <span v-else>None</span>
                </template>
              </v-list-item>
              <v-list-item title="E-mail" :subtitle="contact.email ?? '—'" />
              <v-list-item title="Phone" :subtitle="contact.phone ?? '—'" />
              <v-list-item title="Owner" :subtitle="contact.owner.displayName" />
              <v-list-item title="Created" :subtitle="format.dateTime(contact.createdAt)" />
            </v-list>
          </v-card>
          <NotesCard
            :record="{ type: 'contact', id: contact.id, label: contact.displayName }"
            :initial="overview.data.value?.notes ?? null"
            :warning="notesWarning?.message ?? null"
          />
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Timeline</h2></v-card-title>
            <CustomerTimeline :entries="overview.data.value?.timeline ?? []" />
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value.history" />
          </v-card>
        </v-col>
      </v-row>

      <v-dialog v-model="creating" max-width="760" aria-labelledby="deal-form-title">
        <v-card>
          <v-card-title><h2 id="deal-form-title" class="text-h6">New deal</h2></v-card-title>
          <v-card-text>
            <DealForm
              v-if="creating && pipeline"
              :stages="pipeline.stages"
              :assignees="assignees"
              :initial-contact="picked"
              :submitting="creator.submitting.value"
              :field-errors="creator.fieldErrors.value"
              :form-error="creator.formError.value"
              @submit="createDeal"
              @cancel="creating = false"
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
              v-if="logging && picked"
              :initial-contacts="[picked]"
              :companies="contact.company ? [contact.company] : []"
              :deals="
                detail.data.value.deals
                  .filter((deal) => deal.status === 'pending')
                  .map((deal) => ({ id: deal.id, title: deal.title }))
              "
              :initial-company-id="contact.company?.id ?? null"
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
