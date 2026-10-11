<script setup lang="ts">
/**
 * Create or edit a task: title, description, status, priority, assignee, and due date.
 *
 * A composition of Vuetify form primitives. Like the deal form it owns its draft and never resets
 * it after a failed save, so a version conflict keeps the user's edits while the parent offers to
 * reload. It emits the full draft; the parent decides what changed.
 *
 * @fires submit With the draft.
 * @fires cancel When the user cancels.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import type { UserRef } from '../../shared/api/crm.ts';
import {
  CreateTaskInputSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task
} from '../../shared/api/projects.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import type { TaskFormValue } from '../services/task-draft.ts';
import { TASK_PRIORITY_VIEW, TASK_STATUS_LABELS } from './taskLabels.ts';

const props = defineProps<{
  /**
   * The task being edited; absent when creating.
   */
  task?: Task | null;
  /**
   * Users a task may be assigned to.
   */
  assignees: readonly UserRef[];
  /**
   * Whether a submission is in flight.
   */
  submitting?: boolean;
  /**
   * Server field messages.
   */
  fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Server form message.
   */
  formError?: string | null;
}>();

const emit = defineEmits<{
  /**
   * The user submitted a valid draft.
   */
  submit: [value: TaskFormValue];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

const draft = reactive<TaskFormValue>({
  title: props.task?.title ?? '',
  description: props.task?.description ?? '',
  status: props.task?.status ?? 'todo',
  priority: props.task?.priority ?? 'no_priority',
  assigneeId: props.task?.assignee?.id ?? null,
  dueDate: props.task?.dueDate ?? ''
});
const localErrors = ref<Record<string, string>>({});
const validation = useFieldValidation(CreateTaskInputSchema, () => ({ ...draft }));
const summary = ref<HTMLElement | null>(null);

const statusItems = TASK_STATUSES.map((value) => ({ title: TASK_STATUS_LABELS[value], value }));
const priorityItems = TASK_PRIORITIES.map((value) => ({
  title: TASK_PRIORITY_VIEW[value].label,
  value
}));

/**
 * Messages for one field, local first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: string): string[] {
  const message =
    validation.errors.value[field] ?? localErrors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Validate locally, then emit.
 */
function onSubmit(): void {
  localErrors.value = draft.title.trim() === '' ? { title: 'Title is required.' } : {};
  if (!validation.submit()) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  if (Object.keys(localErrors.value).length > 0) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  emit('submit', { ...draft });
}

watch(
  () => [props.fieldErrors, props.formError],
  async () => {
    if (props.formError || Object.keys(props.fieldErrors ?? {}).length > 0) {
      await nextTick();
      summary.value?.focus();
    }
  }
);
</script>

<template>
  <v-form novalidate aria-labelledby="task-form-title" @submit.prevent="onSubmit">
    <div
      v-if="
        formError
        || Object.keys(localErrors).length > 0
        || Object.keys(validation.errors.value).length > 0
      "
      ref="summary"
      tabindex="-1"
      class="mb-4"
      data-testid="form-summary"
    >
      <v-alert type="error" variant="tonal" role="alert">{{
        formError ?? 'Please correct the highlighted fields.'
      }}</v-alert>
    </div>
    <v-row density="compact">
      <v-col cols="12">
        <v-text-field
          v-model="draft.title"
          @blur="validation.blur('title')"
          label="Title"
          required
          counter="200"
          :error-messages="errorsFor('title')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.status"
          :items="statusItems"
          label="Status"
          :error-messages="errorsFor('status')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.priority"
          :items="priorityItems"
          label="Priority"
          :error-messages="errorsFor('priority')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.assigneeId"
          :items="[{ id: null, displayName: 'Unassigned' }, ...assignees]"
          item-title="displayName"
          item-value="id"
          label="Assignee"
          :error-messages="errorsFor('assigneeId')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.dueDate"
          @blur="validation.blur('dueDate')"
          label="Due date"
          type="date"
          :error-messages="errorsFor('dueDate')"
        />
      </v-col>
      <v-col cols="12">
        <v-textarea
          v-model="draft.description"
          @blur="validation.blur('description')"
          label="Description"
          rows="3"
          auto-grow
          counter="8000"
          :error-messages="errorsFor('description')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">{{
        task ? 'Save task' : 'Add task'
      }}</v-btn>
    </div>
  </v-form>
</template>
