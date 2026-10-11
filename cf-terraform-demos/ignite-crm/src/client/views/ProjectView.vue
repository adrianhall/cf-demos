<script setup lang="ts">
/**
 * One project: customer context (source deal, company, contact), status and lead, the task board
 * (or an accessible table), task creation and editing, and history.
 *
 * Moving a task uses the board's keyboard-first status menu and the task's current version; a lost
 * race refreshes the board and explains what happened. Editing happens in a dialog that keeps the
 * user's draft on a version conflict and offers to load the latest version.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { mdiPencil, mdiPlus } from '@mdi/js';
import type { UserRef } from '../../shared/api/crm.ts';
import type { ProjectStatus, Task, TaskStatus } from '../../shared/api/projects.ts';
import HistoryList from '../components/HistoryList.vue';
import ResourceState from '../components/ResourceState.vue';
import TaskBoard from '../components/TaskBoard.vue';
import TaskForm from '../components/TaskForm.vue';
import {
  PROJECT_STATUS_VIEW,
  TASK_PRIORITY_VIEW,
  TASK_STATUS_LABELS
} from '../components/taskLabels.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api, ApiError, newIdempotencyKey } from '../services/api-client.ts';
import {
  type TaskFormValue,
  toCreateTaskInput,
  toUpdateTaskInput
} from '../services/task-draft.ts';

const props = defineProps<{
  /**
   * Project id from the route.
   */
  id: string;
}>();

const format = useFormat();
const { can } = useSession();
const detail = useResource((signal) => api.project(props.id, signal));
const project = computed(() => detail.data.value?.project ?? null);
const tasks = computed(() => detail.data.value?.tasks ?? []);
const archived = computed(() => project.value?.status === 'archived');
const canWrite = computed(() => can('project.write') && !archived.value);
const view = ref<'board' | 'table'>('board');

watch(
  () => props.id,
  () => void detail.load(),
  { immediate: true }
);

const assignees = shallowRef<UserRef[]>([]);

/**
 * Load assignable users once.
 *
 * @returns Once loaded (or left empty on failure; the server still validates).
 */
async function ensureAssignees(): Promise<void> {
  if (assignees.value.length === 0) {
    assignees.value = await api.assignees().catch(() => []);
  }
}

const movingId = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * Move a task to another column with its current version.
 *
 * @param task The task.
 * @param status The target status.
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
        ? `${task.title} was changed by someone else. The board has been refreshed; try again.`
        : caught instanceof ApiError
          ? caught.message
          : 'Could not move the task.';
  } finally {
    movingId.value = null;
    await detail.load();
  }
}

const editing = ref(false);
/**
 * The task as it was when the dialog opened: the base the user's edits are measured against.
 */
const baseTask = shallowRef<Task | null>(null);
/**
 * The newest known copy of that task: supplies the version the save is checked against.
 */
const editingTask = shallowRef<Task | null>(null);
const editor = useSubmission({ forbidden: 'Your role does not allow changing tasks.' });

/**
 * Open the task dialog, for a new task (`null`) or an existing one.
 *
 * @param task The task to edit, or `null` to create.
 */
async function openTask(task: Task | null): Promise<void> {
  editor.reset();
  baseTask.value = task;
  editingTask.value = task;
  await ensureAssignees();
  editing.value = true;
}

/**
 * Save the dialog: create, or send only the fields the user changed.
 *
 * Changes are measured against the task _as the dialog opened_ ({@link baseTask}), and sent with
 * the newest known version. After a conflict and "Load latest version", a field the user never
 * touched therefore stays as the other person left it, instead of the stale draft value silently
 * reverting their change.
 *
 * @param value The form value.
 */
async function saveTask(value: TaskFormValue): Promise<void> {
  const current = editingTask.value;
  const base = baseTask.value;
  let saved: Task | undefined;
  if (current === null || base === null) {
    saved = await editor.run((key) => api.createTask(props.id, toCreateTaskInput(value), key));
  } else {
    const changes = toUpdateTaskInput(base, value);
    if (changes === null) {
      editing.value = false;
      return;
    }
    saved = await editor.run((key) => api.updateTask(current.id, changes, current.version, key));
  }
  if (saved !== undefined) {
    editing.value = false;
    notice.value = base === null ? `Added ${saved.title}.` : `Saved ${saved.title}.`;
    await detail.load();
  }
}

/**
 * Load the latest version of the task under the open dialog, keeping the user's draft.
 */
async function reloadTask(): Promise<void> {
  await detail.load();
  const latest = tasks.value.find((task) => task.id === editingTask.value?.id);
  if (latest !== undefined) {
    editingTask.value = latest;
  }
  editor.conflict.value = false;
  editor.formError.value =
    'The latest version is loaded. Your edits are still in the form; review them and save again.';
}

const statusSaving = ref(false);
const statusError = ref<string | null>(null);

/**
 * Change the project status (archive/unarchive needs `project.manage`; the server decides).
 *
 * @param status The new status.
 */
async function setStatus(status: ProjectStatus): Promise<void> {
  const current = project.value;
  if (current === null || status === current.status) {
    return;
  }
  statusSaving.value = true;
  statusError.value = null;
  try {
    await api.updateProject(current.id, { status }, current.version, newIdempotencyKey());
  } catch (caught) {
    statusError.value =
      caught instanceof ApiError && caught.kind === 'forbidden'
        ? 'Only managers and owners can archive or unarchive a project.'
        : caught instanceof ApiError
          ? caught.message
          : 'Could not change the status.';
  } finally {
    statusSaving.value = false;
    await detail.load();
  }
}

const statusItems = computed(() =>
  (Object.keys(PROJECT_STATUS_VIEW) as ProjectStatus[]).map((value) => ({
    title: PROJECT_STATUS_VIEW[value].label,
    value
  }))
);
</script>

<template>
  <ResourceState
    :state="detail.state.value"
    :error="detail.error.value"
    :has-data="detail.data.value !== null"
    skeleton="article"
    @retry="detail.load"
  >
    <section v-if="project && detail.data.value" aria-labelledby="project-title">
      <v-breadcrumbs
        :items="[{ title: 'Projects', to: { name: 'projects' } }, { title: project.name }]"
        class="px-0"
      />
      <div class="d-flex flex-wrap align-center ga-2 mb-1">
        <h1 id="project-title" class="text-h4 flex-grow-1">{{ project.name }}</h1>
        <v-btn v-if="canWrite" color="primary" :prepend-icon="mdiPlus" @click="openTask(null)"
          >Add task</v-btn
        >
      </div>
      <p class="mb-4 d-flex flex-wrap align-center ga-2">
        <v-chip
          :color="PROJECT_STATUS_VIEW[project.status].color"
          size="small"
          variant="tonal"
          label
          >{{ PROJECT_STATUS_VIEW[project.status].label }}</v-chip
        >
        <span class="text-body-2">Lead: {{ project.lead.displayName }}</span>
        <span v-if="project.targetDate" class="text-body-2"
          >· Target {{ format.date(project.targetDate) }}</span
        >
      </p>
      <v-alert v-if="archived" type="info" variant="tonal" density="compact" class="mb-4">
        This project is archived and read-only.
      </v-alert>
      <v-alert
        v-if="!can('project.write')"
        type="info"
        variant="tonal"
        density="compact"
        class="mb-4"
      >
        Your role can view delivery work but not change it.
      </v-alert>
      <!-- Polite live region: announces moves and saves to screen-reader users. -->
      <div aria-live="polite" class="mb-2">
        <v-alert
          v-if="notice"
          type="info"
          variant="tonal"
          density="compact"
          closable
          data-testid="board-notice"
          @click:close="notice = null"
          >{{ notice }}</v-alert
        >
      </div>

      <v-row>
        <v-col cols="12" md="8">
          <v-card class="mb-4">
            <v-card-title class="d-flex flex-wrap align-center ga-2">
              <h2 class="text-h6 flex-grow-1">Tasks</h2>
              <v-btn-toggle v-model="view" mandatory density="compact" aria-label="Task view">
                <v-btn value="board">Board</v-btn>
                <v-btn value="table">Table</v-btn>
              </v-btn-toggle>
            </v-card-title>
            <v-card-text>
              <TaskBoard
                v-if="view === 'board'"
                :tasks="tasks"
                :editable="canWrite"
                :moving-id="movingId"
                @move="move"
                @open="openTask"
              />
              <v-table v-else density="comfortable" aria-label="Tasks">
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Status</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Assignee</th>
                    <th scope="col">Due</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="task in tasks" :key="task.id">
                    <td>
                      <v-btn
                        v-if="canWrite"
                        variant="text"
                        class="px-0 text-none"
                        :aria-label="`Edit ${task.title}`"
                        @click="openTask(task)"
                        >{{ task.title }}</v-btn
                      >
                      <span v-else>{{ task.title }}</span>
                    </td>
                    <td>{{ TASK_STATUS_LABELS[task.status] }}</td>
                    <td>{{ TASK_PRIORITY_VIEW[task.priority].label }}</td>
                    <td>{{ task.assignee?.displayName ?? 'Unassigned' }}</td>
                    <td>{{ task.dueDate ? format.date(task.dueDate) : '—' }}</td>
                  </tr>
                  <tr v-if="tasks.length === 0">
                    <td colspan="5" class="text-medium-emphasis">No tasks yet.</td>
                  </tr>
                </tbody>
              </v-table>
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="4">
          <v-card class="mb-4">
            <v-card-title><h2 class="text-h6">Customer</h2></v-card-title>
            <v-list density="compact">
              <v-list-item title="From deal">
                <template #subtitle>
                  <router-link
                    v-if="project.sourceDeal"
                    :to="{ name: 'deal', params: { id: project.sourceDeal.id } }"
                    >{{ project.sourceDeal.title }}</router-link
                  >
                  <span v-else>Standalone</span>
                </template>
              </v-list-item>
              <v-list-item title="Company">
                <template #subtitle>
                  <router-link
                    v-if="project.company"
                    :to="{ name: 'company', params: { id: project.company.id } }"
                    >{{ project.company.name }}</router-link
                  >
                  <span v-else>None</span>
                </template>
              </v-list-item>
              <v-list-item title="Contact">
                <template #subtitle>
                  <router-link
                    v-if="project.primaryContact"
                    :to="{ name: 'contact', params: { id: project.primaryContact.id } }"
                    >{{ project.primaryContact.displayName }}</router-link
                  >
                  <span v-else>None</span>
                </template>
              </v-list-item>
            </v-list>
            <v-card-text v-if="project.description" class="pt-0">{{
              project.description
            }}</v-card-text>
          </v-card>
          <v-card v-if="can('project.write')" class="mb-4">
            <v-card-title><h2 class="text-h6">Status</h2></v-card-title>
            <v-card-text>
              <v-select
                :model-value="project.status"
                :items="statusItems"
                label="Project status"
                :loading="statusSaving"
                :error-messages="statusError ? [statusError] : []"
                hint="Archiving needs a manager or owner."
                persistent-hint
                @update:model-value="setStatus"
              />
            </v-card-text>
          </v-card>
          <v-card>
            <v-card-title><h2 class="text-h6">History</h2></v-card-title>
            <HistoryList :entries="detail.data.value.history" />
          </v-card>
        </v-col>
      </v-row>

      <v-dialog v-model="editing" max-width="680" aria-labelledby="task-form-title" persistent>
        <v-card>
          <v-card-title
            ><h2 id="task-form-title" class="text-h6">
              {{ editingTask ? 'Edit task' : 'Add task' }}
            </h2></v-card-title
          >
          <v-card-text>
            <v-alert
              v-if="editor.conflict.value"
              type="warning"
              variant="tonal"
              class="mb-4"
              data-testid="conflict"
            >
              Someone else changed this task after you opened it. Your edits are kept below.
              <template #append>
                <v-btn variant="text" @click="reloadTask">Load latest version</v-btn>
              </template>
            </v-alert>
            <TaskForm
              v-if="editing"
              :task="editingTask"
              :assignees="assignees"
              :submitting="editor.submitting.value"
              :field-errors="editor.fieldErrors.value"
              :form-error="editor.conflict.value ? null : editor.formError.value"
              @submit="saveTask"
              @cancel="editing = false"
            />
          </v-card-text>
        </v-card>
      </v-dialog>
    </section>
  </ResourceState>
</template>
