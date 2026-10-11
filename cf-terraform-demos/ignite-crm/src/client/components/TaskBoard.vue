<script setup lang="ts">
/**
 * A Linear-style task board: one column per fixed task status, each task a card showing title,
 * priority, assignee, and due date.
 *
 * A reusable component in Vuetify's style (README "Vuetify component library"): Vuetify has no
 * kanban board. Columns are `VCard`s in a responsive `VRow` (stacking on narrow screens), tasks are
 * `VCard`s, and priority is a `VChip`. Moving a task uses a **keyboard-first** `VMenu` listing the
 * other statuses; drag-and-drop is deliberately not offered in release one, so there is exactly one
 * fully accessible way to move work. The board never calls the API: it emits `move` and `open`, and
 * the parent performs the versioned update, so the board is equally usable for any task source.
 *
 * Columns are `role="list"` with a labelled heading; each card's controls are real buttons with
 * accessible names that include the task title.
 *
 * @fires move With the task and its target status when the user picks a new column.
 * @fires open With the task when the user asks to edit it.
 */
import { computed } from 'vue';
import { mdiAccountOutline, mdiCalendar, mdiPencil, mdiSwapHorizontal } from '@mdi/js';
import { TASK_STATUSES, type Task, type TaskStatus } from '../../shared/api/projects.ts';
import { useFormat } from '../composables/useFormat.ts';
import { TASK_PRIORITY_VIEW, TASK_STATUS_LABELS } from './taskLabels.ts';

const props = defineProps<{
  /**
   * Tasks in board order (status, position, id).
   */
  tasks: readonly Task[];
  /**
   * Whether the user may move and edit tasks.
   */
  editable?: boolean;
  /**
   * Id of a task whose move is in flight.
   */
  movingId?: string | null;
  /**
   * Today's date (`YYYY-MM-DD`) for highlighting overdue due dates; omit to disable.
   */
  today?: string;
}>();

const emit = defineEmits<{
  /**
   * The user chose a new status for a task.
   */
  move: [task: Task, status: TaskStatus];
  /**
   * The user asked to edit a task.
   */
  open: [task: Task];
}>();

const format = useFormat();

const columns = computed(() =>
  TASK_STATUSES.map((status) => ({
    status,
    label: TASK_STATUS_LABELS[status],
    tasks: props.tasks.filter((task) => task.status === status)
  }))
);

/**
 * Whether a task is overdue.
 *
 * @param task The task.
 * @returns `true` when it has a due date before today and is not done.
 */
function overdue(task: Task): boolean {
  return (
    props.today !== undefined
    && task.status !== 'done'
    && task.dueDate !== null
    && task.dueDate < props.today
  );
}
</script>

<template>
  <v-row data-testid="task-board">
    <v-col v-for="column in columns" :key="column.status" cols="12" sm="6" lg="3">
      <v-card variant="tonal" color="secondary-strong" class="h-100">
        <v-card-title>
          <h2 :id="`column-${column.status}`" class="text-subtitle-1 font-weight-bold">
            {{ column.label }}
            <span class="text-caption">({{ column.tasks.length }})</span>
          </h2>
        </v-card-title>
        <v-card-text>
          <ul class="board-list" :aria-labelledby="`column-${column.status}`">
            <li v-for="task in column.tasks" :key="task.id" class="mb-2">
              <v-card :data-testid="`task-${task.id}`">
                <v-card-text class="pb-1">
                  <div class="font-weight-medium text-body-1">{{ task.title }}</div>
                  <div class="d-flex flex-wrap align-center ga-1 mt-1">
                    <v-chip
                      :color="TASK_PRIORITY_VIEW[task.priority].color"
                      size="x-small"
                      variant="tonal"
                      label
                      >{{ TASK_PRIORITY_VIEW[task.priority].label }}</v-chip
                    >
                    <span class="text-caption d-inline-flex align-center">
                      <v-icon :icon="mdiAccountOutline" size="x-small" class="mr-1" />
                      {{ task.assignee?.displayName ?? 'Unassigned' }}
                    </span>
                    <span
                      v-if="task.dueDate"
                      class="text-caption d-inline-flex align-center"
                      :class="{ 'text-error font-weight-bold': overdue(task) }"
                    >
                      <v-icon :icon="mdiCalendar" size="x-small" class="mr-1" />
                      {{ format.date(task.dueDate)
                      }}<template v-if="overdue(task)"> (overdue)</template>
                    </span>
                  </div>
                </v-card-text>
                <div v-if="editable" class="d-flex ga-1 px-2 pb-2">
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
                        v-for="target in columns.filter((item) => item.status !== task.status)"
                        :key="target.status"
                        :title="target.label"
                        @click="emit('move', task, target.status)"
                      />
                    </v-list>
                  </v-menu>
                  <v-btn
                    size="small"
                    variant="text"
                    :prepend-icon="mdiPencil"
                    :aria-label="`Edit ${task.title}`"
                    @click="emit('open', task)"
                    >Edit</v-btn
                  >
                </div>
              </v-card>
            </li>
            <li v-if="column.tasks.length === 0" class="text-body-2 text-medium-emphasis">
              No tasks.
            </li>
          </ul>
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>

<style scoped>
.board-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
</style>
