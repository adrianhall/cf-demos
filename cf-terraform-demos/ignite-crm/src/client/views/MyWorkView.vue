<script setup lang="ts">
/**
 * My work: the signed-in user's open assigned tasks across every project, overdue and due first,
 * each linking to its project, with a keyboard-operable status menu so work can be progressed
 * without leaving the list.
 */
import { onMounted, ref } from 'vue';
import { mdiSwapHorizontal } from '@mdi/js';
import { TASK_STATUSES, type Task, type TaskStatus } from '../../shared/api/projects.ts';
import ResourceState from '../components/ResourceState.vue';
import { TASK_PRIORITY_VIEW, TASK_STATUS_LABELS } from '../components/taskLabels.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { focusByLabel } from '../composables/useReturnFocus.ts';
import { useSession } from '../composables/useSession.ts';
import { api, ApiError, newIdempotencyKey } from '../services/api-client.ts';

const { can } = useSession();
const format = useFormat();
const work = useResource((signal) => api.myWork(signal));
const movingId = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * Whether a task is overdue.
 *
 * @param task The task.
 * @returns `true` when due before today.
 */
function overdue(task: Task): boolean {
  const today = work.data.value?.today;
  return today !== undefined && task.dueDate !== null && task.dueDate < today;
}

/**
 * Move a task to another status with its current version.
 *
 * @param task The task.
 * @param status The new status.
 */
async function move(task: Task, status: TaskStatus): Promise<void> {
  movingId.value = task.id;
  notice.value = null;
  try {
    await api.updateTask(task.id, { status }, task.version, newIdempotencyKey());
    notice.value = `${task.title} moved to ${TASK_STATUS_LABELS[status]}.`;
  } catch (caught) {
    notice.value =
      caught instanceof ApiError && caught.kind === 'conflict'
        ? `${task.title} was changed by someone else. The list has been refreshed.`
        : caught instanceof ApiError
          ? caught.message
          : 'Could not move the task.';
  } finally {
    movingId.value = null;
    await work.load();
    // The card was remounted in another column (or left the list): keep focus on its Move button.
    await focusByLabel(`Move ${task.title} to another status`);
  }
}

onMounted(() => void work.load());
</script>

<template>
  <section aria-labelledby="my-work-title">
    <h1 id="my-work-title" class="text-h4 mb-1">My work</h1>
    <p class="text-medium-emphasis mb-4">
      Open tasks assigned to you across projects<template v-if="work.data.value">
        · today is {{ format.date(work.data.value.today) }}</template
      >
    </p>
    <div aria-live="polite" class="mb-2">
      <v-alert
        v-if="notice"
        type="info"
        variant="tonal"
        density="compact"
        closable
        @click:close="notice = null"
        >{{ notice }}</v-alert
      >
    </div>
    <ResourceState
      :state="work.state.value"
      :error="work.error.value"
      :empty="(work.data.value?.items.length ?? 0) === 0"
      :has-data="work.data.value !== null"
      empty-title="Nothing assigned to you"
      empty-text="Tasks assigned to you on any project appear here."
      @retry="work.load"
    >
      <v-card>
        <v-list lines="two" aria-label="My tasks">
          <v-list-item v-for="task in work.data.value?.items ?? []" :key="task.id">
            <v-list-item-title class="text-wrap">
              <v-chip
                :color="TASK_PRIORITY_VIEW[task.priority].color"
                size="x-small"
                variant="tonal"
                label
                class="mr-2"
                >{{ TASK_PRIORITY_VIEW[task.priority].label }}</v-chip
              >{{ task.title }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-wrap">
              {{ TASK_STATUS_LABELS[task.status] }} ·
              <router-link :to="{ name: 'project', params: { id: task.project.id } }">{{
                task.project.name
              }}</router-link>
              <template v-if="task.dueDate">
                ·
                <span :class="{ 'text-error font-weight-bold': overdue(task) }"
                  >Due {{ format.date(task.dueDate)
                  }}<template v-if="overdue(task)"> (overdue)</template></span
                >
              </template>
            </v-list-item-subtitle>
            <template v-if="can('project.write')" #append>
              <v-menu>
                <template #activator="{ props: menu }">
                  <v-btn
                    v-bind="menu"
                    size="small"
                    variant="text"
                    :prepend-icon="mdiSwapHorizontal"
                    :loading="movingId === task.id"
                    :aria-label="`Move ${task.title} to another status`"
                    >Move</v-btn
                  >
                </template>
                <v-list density="compact" :aria-label="`Statuses for ${task.title}`">
                  <v-list-item
                    v-for="status in TASK_STATUSES.filter((item) => item !== task.status)"
                    :key="status"
                    :title="TASK_STATUS_LABELS[status]"
                    @click="move(task, status)"
                  />
                </v-list>
              </v-menu>
            </template>
          </v-list-item>
        </v-list>
      </v-card>
    </ResourceState>
  </section>
</template>
