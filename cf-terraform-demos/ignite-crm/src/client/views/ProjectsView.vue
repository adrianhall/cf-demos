<script setup lang="ts">
/**
 * Projects: a searchable, status-filtered list of delivery projects with task progress. Search and
 * filter live in the URL. Projects are created by converting a won deal (the deal page), so this
 * page has no "new" action in release one.
 */
import { onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { mdiMagnify } from '@mdi/js';
import { PROJECT_STATUSES, type Project, type ProjectStatus } from '../../shared/api/projects.ts';
import ResourceState from '../components/ResourceState.vue';
import { PROJECT_STATUS_VIEW } from '../components/taskLabels.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const route = useRoute();
const router = useRouter();
const format = useFormat();

const search = ref(typeof route.query.q === 'string' ? route.query.q : '');
const status = ref<ProjectStatus | 'all'>(
  PROJECT_STATUSES.includes(route.query.status as ProjectStatus)
    ? (route.query.status as ProjectStatus)
    : 'all'
);
const items = shallowRef<Project[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);

/**
 * The query the filters describe.
 *
 * @returns Query parameters.
 */
function query(): { q?: string; status?: ProjectStatus; limit: number } {
  return {
    limit: 25,
    ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
    ...(status.value === 'all' ? {} : { status: status.value })
  };
}

const page = useResource(async (signal) => {
  const result = await api.projects(query(), signal);
  items.value = [...result.items];
  nextCursor.value = result.nextCursor;
  return result;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([search, status], () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void router.replace({
      query: {
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
    const result = await api.projects({ ...query(), cursor: nextCursor.value });
    items.value = [...items.value, ...result.items];
    nextCursor.value = result.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

/**
 * Completed tasks out of all tasks.
 *
 * @param project The project.
 * @returns E.g. `2 of 5 done`.
 */
function progress(project: Project): string {
  const counts = project.taskCounts;
  const total = counts.todo + counts.in_progress + counts.in_review + counts.done;
  return `${format.count(counts.done)} of ${format.count(total)} done`;
}

onMounted(() => void page.load());
</script>

<template>
  <section aria-labelledby="projects-title">
    <h1 id="projects-title" class="text-h4 mb-1">Projects</h1>
    <p class="text-medium-emphasis mb-4">Delivery work created from won deals.</p>
    <v-row density="compact" class="mb-2">
      <v-col cols="12" sm="8">
        <v-text-field
          v-model="search"
          label="Search projects"
          :prepend-inner-icon="mdiMagnify"
          clearable
          hint="Project, company, or contact"
          role="searchbox"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-select
          v-model="status"
          label="Status"
          :items="[
            { title: 'All', value: 'all' },
            ...PROJECT_STATUSES.map((value) => ({ title: PROJECT_STATUS_VIEW[value].label, value }))
          ]"
        />
      </v-col>
    </v-row>
    <ResourceState
      :state="page.state.value"
      :error="page.error.value"
      :empty="items.length === 0"
      :has-data="page.data.value !== null"
      :empty-title="search || status !== 'all' ? 'No matching projects' : 'No projects yet'"
      empty-text="Win a deal, then use Convert to project on the deal page."
      @retry="page.load"
    >
      <v-list lines="two" aria-label="Projects">
        <v-list-item
          v-for="project in items"
          :key="project.id"
          :to="{ name: 'project', params: { id: project.id } }"
        >
          <v-list-item-title class="text-wrap">{{ project.name }}</v-list-item-title>
          <v-list-item-subtitle class="text-wrap">
            <v-chip
              :color="PROJECT_STATUS_VIEW[project.status].color"
              size="x-small"
              variant="tonal"
              label
              class="mr-2"
              >{{ PROJECT_STATUS_VIEW[project.status].label }}</v-chip
            >
            {{ project.company?.name ?? project.primaryContact?.displayName ?? 'No customer' }} ·
            {{ project.lead.displayName }} · {{ progress(project) }}
          </v-list-item-subtitle>
        </v-list-item>
      </v-list>
      <div v-if="nextCursor" class="d-flex justify-center mt-2">
        <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
      </div>
    </ResourceState>
  </section>
</template>
