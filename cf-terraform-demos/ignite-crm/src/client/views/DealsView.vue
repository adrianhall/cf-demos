<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
/**
 * Deals: a pipeline board of open deals and a searchable, filterable table of all deals, plus the
 * create-deal dialog. The view mode, search, and status filter live in the URL.
 */
import { mdiMagnify, mdiPlus } from '@mdi/js';
import type { UserRef } from '../../shared/api/crm.ts';
import type { Deal, DealStatus, Pipeline, Stage } from '../../shared/api/sales.ts';
import DealForm from '../components/DealForm.vue';
import DealStatusChip from '../components/DealStatusChip.vue';
import PipelineBoard from '../components/PipelineBoard.vue';
import ResourceState from '../components/ResourceState.vue';
import { announce } from '../composables/useAnnouncer.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { focusByLabel, useReturnFocus } from '../composables/useReturnFocus.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api, ApiError, newIdempotencyKey } from '../services/api-client.ts';
import { type DealFormValue, toCreateDealInput } from '../services/deal-draft.ts';

const route = useRoute();
const router = useRouter();
const { can, session } = useSession();
const format = useFormat();

const view = ref<'board' | 'list'>(route.query.view === 'list' ? 'list' : 'board');
const search = ref(typeof route.query.q === 'string' ? route.query.q : '');
const status = ref<DealStatus | 'all'>(
  route.query.status === 'pending' || route.query.status === 'won' || route.query.status === 'lost'
    ? route.query.status
    : 'all'
);
const items = shallowRef<Deal[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const pipeline = shallowRef<Pipeline | null>(null);
const assignees = shallowRef<UserRef[]>([]);

/**
 * The query the current filters describe. The board always shows every open deal.
 *
 * @returns Query parameters.
 */
function query(): { q?: string; status?: DealStatus; limit: number } {
  if (view.value === 'board') {
    return { status: 'pending', limit: 100 };
  }
  return {
    limit: 25,
    ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
    ...(status.value === 'all' ? {} : { status: status.value })
  };
}

const page = useResource(async (signal) => {
  const [result, loadedPipeline] = await Promise.all([
    api.deals(query(), signal),
    pipeline.value ?? api.pipeline(signal)
  ]);
  pipeline.value = loadedPipeline;
  items.value = [...result.items];
  nextCursor.value = result.nextCursor;
  return result;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([view, search, status], () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void router.replace({
      query: {
        ...(view.value === 'list' ? { view: 'list' } : {}),
        ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
        ...(status.value === 'all' ? {} : { status: status.value })
      }
    });
    void page.load();
  }, 250);
});

/**
 * Append the next page.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  loadingMore.value = true;
  try {
    const result = await api.deals({ ...query(), cursor: nextCursor.value });
    items.value = [...items.value, ...result.items];
    nextCursor.value = result.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

const movingId = ref<string | null>(null);
const moveError = ref<string | null>(null);

/**
 * Move a deal to another stage from the board, with its current version.
 *
 * @param deal The deal.
 * @param stage The target stage.
 */
async function move(deal: Deal, stage: Stage): Promise<void> {
  movingId.value = deal.id;
  moveError.value = null;
  try {
    const updated = await api.updateDeal(
      deal.id,
      { stageId: stage.id },
      deal.version,
      newIdempotencyKey()
    );
    items.value = items.value.map((item) => (item.id === updated.id ? updated : item));
    announce(`${deal.title} moved to ${stage.label}.`);
    await focusByLabel(`Move ${deal.title} to another stage`);
  } catch (caught) {
    moveError.value =
      caught instanceof ApiError && caught.kind === 'conflict'
        ? `${deal.title} was changed by someone else. The board has been refreshed; try again.`
        : caught instanceof ApiError
          ? caught.message
          : 'Could not move the deal.';
    await page.load();
    await focusByLabel(`Move ${deal.title} to another stage`);
  } finally {
    movingId.value = null;
  }
}

const dialog = ref(false);
useReturnFocus(dialog);
const submission = useSubmission({ forbidden: 'Your role does not allow creating deals.' });

/**
 * Open the create dialog, loading assignees on first use.
 */
async function openCreate(): Promise<void> {
  submission.reset();
  dialog.value = true;
  if (assignees.value.length === 0) {
    assignees.value = await api.assignees().catch(() => []);
  }
}

/**
 * Create a deal and open it.
 *
 * @param value The form value.
 */
async function create(value: DealFormValue): Promise<void> {
  const deal = await submission.run((key) =>
    api.createDeal(toCreateDealInput(value, session.value?.user.id ?? ''), key)
  );
  if (deal !== undefined) {
    dialog.value = false;
    await router.push({ name: 'deal', params: { id: deal.id } });
  }
}

const stages = computed(() => pipeline.value?.stages ?? []);

onMounted(() => void page.load());
</script>

<template>
  <section aria-labelledby="deals-title">
    <div class="d-flex flex-wrap align-center ga-4 mb-4">
      <h1 id="deals-title" class="text-h4 flex-grow-1">Deals</h1>
      <v-btn-toggle v-model="view" mandatory density="comfortable" aria-label="Deals view">
        <v-btn value="board" :aria-pressed="view === 'board' ? 'true' : 'false'">Pipeline</v-btn>
        <v-btn value="list" :aria-pressed="view === 'list' ? 'true' : 'false'">List</v-btn>
      </v-btn-toggle>
      <v-btn v-if="can('crm.write')" color="primary" :prepend-icon="mdiPlus" @click="openCreate"
        >New deal</v-btn
      >
    </div>
    <v-alert v-if="!can('crm.write')" type="info" variant="tonal" density="compact" class="mb-4">
      Your role can view deals but not create or change them.
    </v-alert>
    <v-alert
      v-if="moveError"
      type="warning"
      variant="tonal"
      role="alert"
      class="mb-4"
      closable
      @click:close="moveError = null"
      >{{ moveError }}</v-alert
    >
    <v-row v-if="view === 'list'" density="compact" class="mb-2">
      <v-col cols="12" sm="8">
        <v-text-field
          v-model="search"
          label="Search deals"
          :prepend-inner-icon="mdiMagnify"
          clearable
          hint="Title, company, or contact"
          type="search"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-select
          v-model="status"
          label="Outcome"
          :items="[
            { title: 'All', value: 'all' },
            { title: 'Open', value: 'pending' },
            { title: 'Won', value: 'won' },
            { title: 'Lost', value: 'lost' }
          ]"
        />
      </v-col>
    </v-row>
    <ResourceState
      :state="page.state.value"
      :error="page.error.value"
      :empty="view === 'list' && items.length === 0"
      :has-data="page.data.value !== null"
      :empty-title="search || status !== 'all' ? 'No matching deals' : 'No deals yet'"
      empty-text="Create a deal from a contact or with New deal."
      @retry="page.load"
    >
      <PipelineBoard
        v-if="view === 'board'"
        :stages="stages"
        :deals="items"
        :editable="can('crm.write')"
        :moving-id="movingId"
        @move="move"
      />
      <template v-else>
        <v-table density="comfortable" aria-label="Deals">
          <thead>
            <tr>
              <th scope="col">Deal</th>
              <th scope="col">Outcome</th>
              <th scope="col" class="text-right">Amount</th>
              <th scope="col">Customer</th>
              <th scope="col">Next action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="deal in items" :key="deal.id">
              <td>
                <router-link :to="{ name: 'deal', params: { id: deal.id } }">{{
                  deal.title
                }}</router-link>
                <div v-if="deal.statusLine" class="text-caption">{{ deal.statusLine }}</div>
              </td>
              <td><DealStatusChip :deal="deal" /></td>
              <td class="text-right">{{ format.money(deal.amountMinor) }}</td>
              <td>{{ deal.company?.name ?? deal.primaryContact.displayName }}</td>
              <td>
                <template v-if="deal.nextActionText"
                  >{{ deal.nextActionText }} ·
                  {{ format.date(deal.nextActionDate ?? '') }}</template
                >
                <span v-else class="text-medium-emphasis">—</span>
              </td>
            </tr>
          </tbody>
        </v-table>
        <div v-if="nextCursor" class="d-flex justify-center mt-2">
          <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
        </div>
      </template>
    </ResourceState>

    <v-dialog v-model="dialog" max-width="760" aria-labelledby="deal-form-title">
      <v-card>
        <v-card-title><h2 id="deal-form-title" class="text-h6">New deal</h2></v-card-title>
        <v-card-text>
          <DealForm
            v-if="dialog && stages.length > 0"
            :stages="stages"
            :assignees="assignees"
            :submitting="submission.submitting.value"
            :field-errors="submission.fieldErrors.value"
            :form-error="submission.formError.value"
            @submit="create"
            @cancel="dialog = false"
          />
        </v-card-text>
      </v-card>
    </v-dialog>
  </section>
</template>
