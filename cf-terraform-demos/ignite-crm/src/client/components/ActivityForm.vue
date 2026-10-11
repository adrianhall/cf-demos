<script setup lang="ts">
/**
 * Log a call or meeting linked to one or more contacts, and optionally a company and a deal.
 *
 * Contacts are chosen with the multi-select `ContactPicker`; selected people stay visible as chips
 * that can be removed with the keyboard. The company and deal are chosen from the records the
 * caller passes in (the context the form was opened from), so the form never needs to search across
 * every deal. The time defaults to now and may not be in the future — an activity records what
 * happened; it is not a calendar event.
 *
 * @fires submit With the request fields.
 * @fires cancel When the user cancels.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import type { CreateActivityInput } from '../../shared/api/sales.ts';
import type { PickedContact } from '../services/deal-draft.ts';
import ContactPicker from './ContactPicker.vue';

const props = defineProps<{
  /**
   * Contacts to preselect (the context the form was opened from).
   */
  initialContacts?: readonly PickedContact[];
  /**
   * Companies the activity may be linked to.
   */
  companies?: readonly { id: string; name: string }[];
  /**
   * Deals the activity may be linked to.
   */
  deals?: readonly { id: string; title: string }[];
  /**
   * Preselected company id.
   */
  initialCompanyId?: string | null;
  /**
   * Preselected deal id.
   */
  initialDealId?: string | null;
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
  submit: [input: CreateActivityInput];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

/**
 * The current local time as a `datetime-local` value.
 *
 * @returns `YYYY-MM-DDTHH:mm` in the browser's time zone.
 */
function localNow(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const draft = reactive({
  type: 'meeting' as 'call' | 'meeting',
  subject: '',
  summary: '',
  occurredAt: localNow(),
  duration: '',
  contacts: [...(props.initialContacts ?? [])] as PickedContact[],
  companyId: props.initialCompanyId ?? null,
  dealId: props.initialDealId ?? null
});
const localErrors = ref<Record<string, string>>({});
const summary = ref<HTMLElement | null>(null);

/**
 * Messages for one field, local first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: string): string[] {
  const message = localErrors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Validate locally, then emit.
 */
function onSubmit(): void {
  const errors: Record<string, string> = {};
  if (draft.subject.trim() === '') {
    errors.subject = 'Subject is required.';
  }
  if (draft.contacts.length === 0) {
    errors.contactIds = 'Choose at least one contact.';
  }
  const occurred = new Date(draft.occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    errors.occurredAt = 'Enter when it happened.';
  }
  const duration = draft.duration.trim() === '' ? null : Number(draft.duration);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) {
    errors.durationMinutes = 'Duration must be 1–1440 whole minutes.';
  }
  localErrors.value = errors;
  if (Object.keys(errors).length > 0) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  emit('submit', {
    type: draft.type,
    subject: draft.subject,
    summary: draft.summary.trim() === '' ? null : draft.summary,
    occurredAt: occurred.toISOString(),
    durationMinutes: duration,
    contactIds: draft.contacts.map((contact) => contact.id),
    companyId: draft.companyId,
    dealId: draft.dealId
  });
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
  <v-form novalidate aria-labelledby="activity-form-title" @submit.prevent="onSubmit">
    <div
      v-if="formError || Object.keys(localErrors).length > 0"
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
      <v-col cols="12" sm="4">
        <v-select
          v-model="draft.type"
          :items="[
            { title: 'Meeting', value: 'meeting' },
            { title: 'Call', value: 'call' }
          ]"
          label="Type"
        />
      </v-col>
      <v-col cols="12" sm="8">
        <v-text-field
          v-model="draft.subject"
          label="Subject"
          :error-messages="errorsFor('subject')"
        />
      </v-col>
      <v-col cols="12">
        <ContactPicker
          v-model="draft.contacts"
          label="Contacts involved"
          multiple
          :error-messages="errorsFor('contactIds')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.companyId"
          :items="[{ id: null, name: 'None' }, ...(companies ?? [])]"
          item-title="name"
          item-value="id"
          label="Company"
          :error-messages="errorsFor('companyId')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.dealId"
          :items="[{ id: null, title: 'None' }, ...(deals ?? [])]"
          item-title="title"
          item-value="id"
          label="Deal"
          :error-messages="errorsFor('dealId')"
        />
      </v-col>
      <v-col cols="12" sm="8">
        <v-text-field
          v-model="draft.occurredAt"
          label="When"
          type="datetime-local"
          :error-messages="errorsFor('occurredAt')"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="draft.duration"
          label="Duration (minutes)"
          inputmode="numeric"
          :error-messages="errorsFor('durationMinutes')"
        />
      </v-col>
      <v-col cols="12">
        <v-textarea
          v-model="draft.summary"
          label="Summary"
          rows="3"
          auto-grow
          counter="4000"
          :error-messages="errorsFor('summary')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">Log activity</v-btn>
    </div>
  </v-form>
</template>
