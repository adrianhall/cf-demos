<script setup lang="ts">
/**
 * Accessible create- and edit-contact form. With a `contact` prop it edits that record (the draft
 * starts from its values and the submit button says "Save contact"); without one it creates.
 *
 * Collects a draft and emits it; the parent submits. Server field errors passed in through
 * `fieldErrors` appear on the matching inputs, and a summary alert receives focus so keyboard and
 * screen-reader users learn about them immediately.
 *
 * @fires submit With the draft when the user submits a valid form.
 * @fires cancel When the user cancels.
 */
import { nextTick, reactive, ref, watch } from 'vue';
import { CreateContactInputSchema, type Contact } from '../../shared/api/crm.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import { type ContactDraft, contactDraftFrom } from '../services/crm-draft.ts';

export type { ContactDraft } from '../services/crm-draft.ts';

const props = defineProps<{
  /**
   * The contact to edit; omit to create a new one. Read once when the form mounts, so a reload
   * underneath an open editor never discards the user's draft.
   */
  contact?: Contact | null;
  /**
   * Whether a submission is in flight.
   */
  submitting?: boolean;
  /**
   * Server-reported field messages.
   */
  fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Server-reported form-level message.
   */
  formError?: string | null;
}>();

const emit = defineEmits<{
  /**
   * The user submitted.
   */
  submit: [draft: ContactDraft];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

const draft = reactive<ContactDraft>(
  props.contact
    ? contactDraftFrom(props.contact)
    : { firstName: '', lastName: '', email: '', phone: '', jobTitle: '', companyName: '' }
);
const localError = ref<string | null>(null);
const validation = useFieldValidation(CreateContactInputSchema, () => ({ ...draft }));
const summary = ref<HTMLElement | null>(null);

/**
 * The message for one field, server first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: keyof ContactDraft): string[] {
  const message = validation.errors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Validate the obvious client-side rule, then emit the draft.
 */
function onSubmit(): void {
  const hasName = [draft.firstName, draft.lastName, draft.companyName].some(
    (value) => value.trim() !== ''
  );
  if (!validation.submit() || !hasName) {
    if (hasName) localError.value = 'Please correct the highlighted fields.';
    localError.value = 'Enter a name or a company.';
    void nextTick(() => summary.value?.focus());
    return;
  }
  localError.value = null;
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
  <v-form novalidate aria-labelledby="contact-form-title" @submit.prevent="onSubmit">
    <div
      v-if="localError || formError"
      ref="summary"
      tabindex="-1"
      class="mb-4"
      data-testid="form-summary"
    >
      <v-alert type="error" variant="tonal" role="alert">{{ localError ?? formError }}</v-alert>
    </div>
    <v-row density="compact">
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.firstName"
          @blur="validation.blur('firstName')"
          label="First name"
          autocomplete="given-name"
          :error-messages="errorsFor('firstName')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.lastName"
          @blur="validation.blur('lastName')"
          label="Last name"
          autocomplete="family-name"
          :error-messages="errorsFor('lastName')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.email"
          @blur="validation.blur('email')"
          label="E-mail"
          type="email"
          autocomplete="email"
          :error-messages="errorsFor('email')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.phone"
          @blur="validation.blur('phone')"
          label="Phone"
          type="tel"
          autocomplete="tel"
          :error-messages="errorsFor('phone')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.jobTitle"
          @blur="validation.blur('jobTitle')"
          label="Job title"
          autocomplete="organization-title"
          :error-messages="errorsFor('jobTitle')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.companyName"
          @blur="validation.blur('companyName')"
          label="Company"
          autocomplete="organization"
          :hint="
            contact
              ? 'Change to move this contact: an existing company with this name is reused; otherwise one is created. Clear to remove the company.'
              : 'An existing company with this name is reused; otherwise one is created.'
          "
          persistent-hint
          :error-messages="errorsFor('companyName')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">{{
        contact ? 'Save contact' : 'Create contact'
      }}</v-btn>
    </div>
  </v-form>
</template>
