<script setup lang="ts">
/**
 * A contact's one next action: shows it, and lets a writer set, replace, or complete it inline.
 *
 * A composition of Vuetify card, form, and button primitives. Saving sends the version the user
 * last saw (`null` when there was none), so two people editing the same contact cannot silently
 * overwrite each other; a conflict keeps the draft and asks the user to reload. The component emits
 * `changed` after a successful save so the parent reloads the timeline.
 *
 * @fires changed After the action was saved or completed.
 */
import { ref, watch } from 'vue';
import { mdiCheck, mdiPencil } from '@mdi/js';
import type { ContactNextAction } from '../../shared/api/sales.ts';
import { useFormat } from '../composables/useFormat.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api } from '../services/api-client.ts';

const props = defineProps<{
  /**
   * Contact id.
   */
  contactId: string;
  /**
   * The open action, or `null`.
   */
  action: ContactNextAction | null;
  /**
   * Whether the user may change it.
   */
  editable: boolean;
}>();

const emit = defineEmits<{
  /**
   * The action was saved or completed.
   */
  changed: [];
}>();

const format = useFormat();
const editing = ref(false);
const text = ref('');
const dueDate = ref('');
const submission = useSubmission({
  forbidden: 'Your role does not allow changing next actions.',
  conflict:
    'Someone else changed this next action. Your text is kept; reload the contact to see theirs.'
});

watch(
  () => props.action,
  (action) => {
    if (!editing.value) {
      text.value = action?.text ?? '';
      dueDate.value = action?.dueDate ?? '';
    }
  },
  { immediate: true }
);

/**
 * Start editing with a fresh intent.
 */
function edit(): void {
  submission.reset();
  editing.value = true;
}

/**
 * Save the draft against the version last seen.
 */
async function save(): Promise<void> {
  const saved = await submission.run((key) =>
    api.setNextAction(
      props.contactId,
      { text: text.value, dueDate: dueDate.value === '' ? null : dueDate.value },
      props.action?.version ?? null,
      key
    )
  );
  if (saved !== undefined) {
    editing.value = false;
    emit('changed');
  }
}

/**
 * Mark the open action done.
 */
async function complete(): Promise<void> {
  const action = props.action;
  if (action === null) {
    return;
  }
  submission.reset();
  const done = await submission.run((key) =>
    api.completeNextAction(props.contactId, action.version, key)
  );
  if (done !== undefined) {
    emit('changed');
  }
}
</script>

<template>
  <v-card>
    <v-card-title><h2 class="text-h6">Next action</h2></v-card-title>
    <v-card-text>
      <v-alert
        v-if="submission.formError.value"
        type="error"
        variant="tonal"
        role="alert"
        density="compact"
        class="mb-3"
        >{{ submission.formError.value }}</v-alert
      >
      <v-form v-if="editing" novalidate aria-label="Next action" @submit.prevent="save">
        <v-text-field
          v-model="text"
          label="What to do"
          counter="140"
          :error-messages="
            submission.fieldErrors.value.text ? [submission.fieldErrors.value.text] : []
          "
        />
        <v-text-field
          v-model="dueDate"
          label="Due date"
          type="date"
          hint="Leave empty for “as soon as possible”."
          persistent-hint
          :error-messages="
            submission.fieldErrors.value.dueDate ? [submission.fieldErrors.value.dueDate] : []
          "
        />
        <div class="d-flex justify-end ga-2 mt-2">
          <v-btn variant="text" :disabled="submission.submitting.value" @click="editing = false"
            >Cancel</v-btn
          >
          <v-btn type="submit" color="primary" :loading="submission.submitting.value"
            >Save next action</v-btn
          >
        </div>
      </v-form>
      <template v-else>
        <p v-if="action" class="text-body-1" data-testid="next-action">
          {{ action.text }}
          <span class="text-medium-emphasis">
            · {{ action.dueDate ? format.date(action.dueDate) : 'As soon as possible' }} ·
            {{ action.assignee.displayName }}</span
          >
        </p>
        <p v-else class="text-medium-emphasis">No next action set.</p>
        <div v-if="editable" class="d-flex ga-2 mt-2">
          <v-btn variant="tonal" size="small" :prepend-icon="mdiPencil" @click="edit">{{
            action ? 'Change' : 'Set next action'
          }}</v-btn>
          <v-btn
            v-if="action"
            variant="text"
            size="small"
            :prepend-icon="mdiCheck"
            :loading="submission.submitting.value"
            @click="complete"
            >Done</v-btn
          >
        </div>
      </template>
    </v-card-text>
  </v-card>
</template>
