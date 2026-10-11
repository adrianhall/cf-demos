<script setup lang="ts">
/**
 * One company's customer overview: details, primary contact, contacts, deals, delivery projects,
 * every call and meeting involving the company or its people, linked notes, a merged timeline, and
 * history — from one composite request (`GET /companies/:id/overview`). A notes-only failure is
 * shown as a warning in the Notes card; the rest of the page still renders. Users with `crm.write`
 * edit the company's details in a dialog that keeps their draft on a validation failure or a
 * version conflict.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { mdiPencil } from '@mdi/js';
import type { Company } from '../../shared/api/crm.ts';
import ActivityList from '../components/ActivityList.vue';
import CompanyForm from '../components/CompanyForm.vue';
import CustomerTimeline from '../components/CustomerTimeline.vue';
import DealList from '../components/DealList.vue';
import HistoryList from '../components/HistoryList.vue';
import NotesCard from '../components/NotesCard.vue';
import ProjectList from '../components/ProjectList.vue';
import ResourceState from '../components/ResourceState.vue';
import { useResource } from '../composables/useResource.ts';
import { useReturnFocus } from '../composables/useReturnFocus.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';
import { type CompanyDraft, toUpdateCompanyInput } from '../services/crm-draft.ts';

const props = defineProps<{
  /**
   * Company id from the route.
   */
  id: string;
}>();

const overview = useResource((signal) => api.companyOverview(props.id, signal));
const detail = {
  ...overview,
  data: computed(() => overview.data.value?.detail ?? null)
};
const notesWarning = computed(
  () => overview.data.value?.warnings.find((warning) => warning.section === 'notes') ?? null
);

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);

const { can } = useSession();
const editing = ref(false);
useReturnFocus(editing);
/**
 * The company as it was when the editor opened: the base the user's edits are measured against.
 */
const baseCompany = shallowRef<Company | null>(null);
const editor = useSubmission({ forbidden: 'Your role does not allow changing companies.' });
const noChanges = ref(false);

/**
 * Open the company editor.
 */
function openEdit(): void {
  editor.reset();
  noChanges.value = false;
  baseCompany.value = detail.data.value?.company ?? null;
  editing.value = true;
}

/**
 * Save only the changed fields against the newest loaded version.
 *
 * @param draft The form value.
 */
async function saveCompany(draft: CompanyDraft): Promise<void> {
  const current = detail.data.value?.company ?? null;
  const base = baseCompany.value ?? current;
  if (current === null || base === null) {
    return;
  }
  const changes = toUpdateCompanyInput(base, draft);
  if (changes === null) {
    noChanges.value = true;
    editing.value = false;
    return;
  }
  const updated = await editor.run((key) =>
    api.updateCompany(current.id, changes, current.version, key)
  );
  if (updated !== undefined) {
    editing.value = false;
    await detail.load();
  }
}

/**
 * Load the latest version underneath the open editor, keeping the user's draft.
 */
async function reloadLatest(): Promise<void> {
  await detail.load();
  editor.conflict.value = false;
  editor.formError.value =
    'The latest version is loaded. Your edits are still in the form; review them and save again.';
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
    <section v-if="detail.data.value" aria-labelledby="company-title">
      <v-breadcrumbs
        :items="[
          { title: 'Companies', to: { name: 'companies' } },
          { title: detail.data.value.company.name }
        ]"
        class="px-0"
      />
      <div class="d-flex flex-wrap align-center ga-2 mb-4">
        <h1 id="company-title" class="text-h4 flex-grow-1">
          {{ detail.data.value.company.name }}
        </h1>
        <v-btn v-if="can('crm.write')" variant="tonal" :prepend-icon="mdiPencil" @click="openEdit"
          >Edit company</v-btn
        >
      </div>
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
              <v-list-item title="Address" :subtitle="detail.data.value.company.address ?? '—'" />
              <v-list-item
                title="Stock symbol"
                :subtitle="detail.data.value.company.stockSymbol ?? '—'"
              />
              <v-list-item title="Companies House">
                <template #subtitle>
                  <a
                    v-if="detail.data.value.company.companiesHouseUrl"
                    :href="detail.data.value.company.companiesHouseUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    >View registration</a
                  >
                  <span v-else>—</span>
                </template>
              </v-list-item>
              <v-list-item
                title="Primary contact"
                :subtitle="detail.data.value.company.primaryContact?.displayName ?? 'Not set'"
              />
            </v-list>
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">Contacts</h2></v-card-title>
            <v-list role="group" aria-label="Company contacts">
              <v-list-item
                v-for="contact in detail.data.value.contacts"
                :key="contact.id"
                :to="{ name: 'contact', params: { id: contact.id } }"
                :title="contact.displayName"
                :subtitle="contact.jobTitle ?? ''"
              />
              <v-list-item
                v-if="detail.data.value.contacts.length === 0"
                title="No contacts at this company."
              />
            </v-list>
          </v-card>
          <v-card class="mt-4">
            <v-card-title><h2 class="text-h6">Calls and meetings</h2></v-card-title>
            <ActivityList :activities="detail.data.value.activities" />
          </v-card>
        </v-col>
        <v-col cols="12" md="5">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Deals</h2></v-card-title>
            <DealList
              :deals="detail.data.value.deals"
              empty-text="No deals with this company yet."
            />
          </v-card>
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Projects</h2></v-card-title>
            <ProjectList
              :projects="detail.data.value.projects"
              empty-text="No delivery projects for this company yet."
            />
          </v-card>
          <NotesCard
            :record="{
              type: 'company',
              id: detail.data.value.company.id,
              label: detail.data.value.company.name
            }"
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
      <v-dialog v-model="editing" max-width="720" aria-labelledby="company-form-title" persistent>
        <v-card>
          <v-card-title><h2 id="company-form-title" class="text-h6">Edit company</h2></v-card-title>
          <v-card-text>
            <v-alert
              v-if="editor.conflict.value"
              type="warning"
              variant="tonal"
              class="mb-4"
              data-testid="conflict"
            >
              Someone else changed this company after you opened it. Your edits are kept below.
              <template #append>
                <v-btn variant="text" @click="reloadLatest">Load latest version</v-btn>
              </template>
            </v-alert>
            <CompanyForm
              v-if="editing && baseCompany"
              :company="baseCompany"
              :contacts="detail.data.value.contacts"
              :submitting="editor.submitting.value"
              :field-errors="editor.fieldErrors.value"
              :form-error="editor.conflict.value ? null : editor.formError.value"
              @submit="saveCompany"
              @cancel="editing = false"
            />
          </v-card-text>
        </v-card>
      </v-dialog>
    </section>
  </ResourceState>
</template>
