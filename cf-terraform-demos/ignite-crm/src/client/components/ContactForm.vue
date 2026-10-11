<script setup lang="ts">
/**
 * Accessible create-contact form.
 *
 * Collects a draft and emits it; the parent submits. Server field errors passed in through
 * `fieldErrors` appear on the matching inputs, and a summary alert receives focus so keyboard and
 * screen-reader users learn about them immediately.
 *
 * @fires submit With the draft when the user submits a valid form.
 * @fires cancel When the user cancels.
 */
import { nextTick, reactive, ref, watch } from 'vue';

/**
 * Editable form fields.
 */
export interface ContactDraft {
  /**
   * Given name.
   */
  firstName: string;
  /**
   * Family name.
   */
  lastName: string;
  /**
   * E-mail.
   */
  email: string;
  /**
   * Telephone.
   */
  phone: string;
  /**
   * Job title.
   */
  jobTitle: string;
  /**
   * Company name to reuse or create.
   */
  companyName: string;
}

const props = defineProps<{
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

const draft = reactive<ContactDraft>({
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  jobTitle: '',
  companyName: ''
});
const localError = ref<string | null>(null);
const summary = ref<HTMLElement | null>(null);

/**
 * The message for one field, server first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: keyof ContactDraft): string[] {
  const message = props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Validate the obvious client-side rule, then emit the draft.
 */
function onSubmit(): void {
  const hasName = [draft.firstName, draft.lastName, draft.companyName].some(
    (value) => value.trim() !== ''
  );
  if (!hasName) {
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
          label="First name"
          autocomplete="given-name"
          :error-messages="errorsFor('firstName')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.lastName"
          label="Last name"
          autocomplete="family-name"
          :error-messages="errorsFor('lastName')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.email"
          label="E-mail"
          type="email"
          autocomplete="email"
          :error-messages="errorsFor('email')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.phone"
          label="Phone"
          type="tel"
          autocomplete="tel"
          :error-messages="errorsFor('phone')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.jobTitle"
          label="Job title"
          autocomplete="organization-title"
          :error-messages="errorsFor('jobTitle')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.companyName"
          label="Company"
          autocomplete="organization"
          hint="An existing company with this name is reused; otherwise one is created."
          persistent-hint
          :error-messages="errorsFor('companyName')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">Create contact</v-btn>
    </div>
  </v-form>
</template>
