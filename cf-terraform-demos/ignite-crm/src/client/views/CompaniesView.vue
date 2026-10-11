<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
/**
 * Companies: searchable list with cursor paging.
 */
import { mdiMagnify } from '@mdi/js';
import type { CompanySummary } from '../../shared/api/crm.ts';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const format = useFormat();
const search = ref('');
const items = ref<CompanySummary[]>([]);
const nextCursor = ref<string | null>(null);

const page = useResource(async (signal) => {
  const result = await api.companies({ q: search.value.trim() }, signal);
  items.value = [...result.items];
  nextCursor.value = result.nextCursor;
  return result;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void page.load(), 250);
});

/**
 * Append the next page.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  const result = await api.companies({ q: search.value.trim(), cursor: nextCursor.value });
  items.value = [...items.value, ...result.items];
  nextCursor.value = result.nextCursor;
}

onMounted(() => void page.load());
</script>

<template>
  <section aria-labelledby="companies-title">
    <h1 id="companies-title" class="text-h4 mb-4">Companies</h1>
    <v-text-field
      v-model="search"
      label="Search companies"
      :prepend-inner-icon="mdiMagnify"
      clearable
      type="search"
      class="mb-4"
    />
    <ResourceState
      :state="page.state.value"
      :error="page.error.value"
      :empty="items.length === 0"
      :has-data="page.data.value !== null"
      empty-title="No companies"
      empty-text="Companies are created automatically when you add a contact with a company name."
      @retry="page.load"
    >
      <v-list lines="two" role="group" aria-label="Companies">
        <v-list-item
          v-for="company in items"
          :key="company.id"
          :to="{ name: 'company', params: { id: company.id } }"
          :title="company.name"
          :subtitle="`${format.count(company.contactCount)} contact${company.contactCount === 1 ? '' : 's'}`"
        />
      </v-list>
      <div v-if="nextCursor" class="d-flex justify-center mt-2">
        <v-btn variant="tonal" @click="loadMore">Load more</v-btn>
      </div>
    </ResourceState>
  </section>
</template>
