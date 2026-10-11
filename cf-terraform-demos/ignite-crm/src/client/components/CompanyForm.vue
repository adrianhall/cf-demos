<script setup lang="ts">
/**
 * Accessible edit-company form: name, address, stock symbol, Companies House link, and primary
 * contact (chosen from the company's own active contacts, the only ones the server accepts).
 *
 * The draft starts from the company when the form mounts and is never reset by the parent, so a
 * version conflict or validation failure keeps the user's edits. Server field errors appear on the
 * matching inputs, and the summary receives focus so keyboard and screen-reader users hear them.
 *
 * @fires submit With the draft when the user submits.
 * @fires cancel When the user cancels.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import {
  CreateCompanyInputSchema,
  type Company,
  type ContactSummary
} from '../../shared/api/crm.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import { type CompanyDraft, companyDraftFrom } from '../services/crm-draft.ts';

const props = defineProps<{
  /**
   * The company to edit, read once when the form mounts.
   */
  company: Company;
  /**
   * The company's active contacts, offered as primary contact.
   */
  contacts: readonly ContactSummary[];
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
  submit: [draft: CompanyDraft];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

const draft = reactive<CompanyDraft>(companyDraftFrom(props.company));
const localError = ref<string | null>(null);
const validation = useFieldValidation(CreateCompanyInputSchema, () => ({
  name: draft.name,
  address: draft.address,
  stockSymbol: draft.stockSymbol,
  companiesHouseUrl: draft.companiesHouseUrl
}));
const summary = ref<HTMLElement | null>(null);

/**
 * Primary-contact choices: "None" plus the company's contacts.
 */
const contactItems = computed(() => [
  { title: 'None', value: '' },
  ...props.contacts.map((contact) => ({ title: contact.displayName, value: contact.id }))
]);

/**
 * The message for one field.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: keyof CompanyDraft): string[] {
  const message = validation.errors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Check the required name locally, then emit the draft.
 */
function onSubmit(): void {
  if (!validation.submit()) {
    localError.value = validation.errors.value.name ?? 'Please correct the highlighted fields.';
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
  <v-form novalidate aria-labelledby="company-form-title" @submit.prevent="onSubmit">
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
      <v-col cols="12">
        <v-text-field
          v-model="draft.name"
          @blur="validation.blur('name')"
          label="Company name"
          required
          autocomplete="organization"
          :error-messages="errorsFor('name')"
        />
      </v-col>
      <v-col cols="12">
        <v-textarea
          v-model="draft.address"
          @blur="validation.blur('address')"
          label="Address"
          rows="3"
          auto-grow
          autocomplete="street-address"
          :error-messages="errorsFor('address')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.stockSymbol"
          @blur="validation.blur('stockSymbol')"
          label="Stock symbol"
          :error-messages="errorsFor('stockSymbol')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.primaryContactId"
          :items="contactItems"
          label="Primary contact"
          :error-messages="errorsFor('primaryContactId')"
        />
      </v-col>
      <v-col cols="12">
        <v-text-field
          v-model="draft.companiesHouseUrl"
          @blur="validation.blur('companiesHouseUrl')"
          label="Companies House link"
          type="url"
          hint="A find-and-update.company-information.service.gov.uk company page."
          persistent-hint
          :error-messages="errorsFor('companiesHouseUrl')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">Save company</v-btn>
    </div>
  </v-form>
</template>
