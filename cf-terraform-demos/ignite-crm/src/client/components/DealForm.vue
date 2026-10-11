<script setup lang="ts">
/**
 * Create or edit a deal.
 *
 * The form separates the fixed fields the system reasons about (outcome, stage) from the free-text
 * status line and the dated next action, as the SPA specification requires. It owns its draft and
 * **never resets it after a failed save**: on a version conflict the parent shows the message and a
 * reload action while the user's edits stay in the inputs.
 *
 * Contacts are chosen with a searchable `VAutocomplete` (keyboard operable), and the company
 * follows the chosen contact unless the user picks "no company".
 *
 * @fires submit With the draft converted to request fields.
 * @fires cancel When the user cancels.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { UserRef } from '../../shared/api/crm.ts';
import {
  CreateDealInputSchema,
  type Deal,
  type DealStatus,
  type Stage
} from '../../shared/api/sales.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import { useSession } from '../composables/useSession.ts';
import type { DealFormValue, PickedContact } from '../services/deal-draft.ts';
import ContactPicker from './ContactPicker.vue';

const props = defineProps<{
  /**
   * Stages in pipeline order.
   */
  stages: readonly Stage[];
  /**
   * Users a deal may be assigned to.
   */
  assignees: readonly UserRef[];
  /**
   * The deal being edited; absent when creating.
   */
  deal?: Deal | null;
  /**
   * Preselected primary contact when creating from a contact page.
   */
  initialContact?: PickedContact | null;
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
  submit: [value: DealFormValue];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

const { session, can } = useSession();

const draft = reactive({
  title: props.deal?.title ?? '',
  contact: (props.deal
    ? { ...props.deal.primaryContact, companyId: props.deal.company?.id }
    : (props.initialContact ?? null)) as PickedContact | null,
  withCompany: props.deal === null || props.deal === undefined ? true : props.deal.company !== null,
  stageId: props.deal?.stage.id ?? props.stages[0]?.id ?? '',
  status: props.deal?.status ?? ('pending' as DealStatus),
  amount:
    props.deal === null || props.deal === undefined
      ? ''
      : (props.deal.amountMinor / 100).toFixed(2),
  statusLine: props.deal?.statusLine ?? '',
  nextActionText: props.deal?.nextActionText ?? '',
  nextActionDate: props.deal?.nextActionDate ?? '',
  expectedCloseDate: props.deal?.expectedCloseDate ?? '',
  ownerId: props.deal?.owner.id ?? session.value?.user.id ?? ''
});
const localErrors = ref<Record<string, string>>({});
const validation = useFieldValidation(CreateDealInputSchema, () => ({
  title: draft.title,
  primaryContactId: draft.contact?.id ?? '',
  stageId: draft.stageId,
  amountMinor: parseAmount(draft.amount),
  statusLine: draft.statusLine,
  nextActionText: closed.value ? '' : draft.nextActionText,
  nextActionDate: closed.value ? '' : draft.nextActionDate,
  expectedCloseDate: draft.expectedCloseDate,
  ...(draft.ownerId !== '' ? { ownerId: draft.ownerId } : {})
}));
const summary = ref<HTMLElement | null>(null);

const statusItems = [
  { title: 'Open (pending)', value: 'pending' },
  { title: 'Won', value: 'won' },
  { title: 'Lost', value: 'lost' }
];
const closed = computed(() => draft.status !== 'pending');
const canAssign = computed(() => can('crm.assign'));
const messages = computed(() => ({
  ...props.fieldErrors,
  ...validation.errors.value,
  ...localErrors.value
}));
const hiddenErrors = computed(() =>
  Object.entries(messages.value)
    .filter(([field]) => !VISIBLE_FIELDS.has(field))
    .map(([, message]) => message)
);

/**
 * Fields that have their own input and show their own message.
 */
const VISIBLE_FIELDS = new Set([
  'title',
  'primaryContactId',
  'stageId',
  'status',
  'amountMinor',
  'statusLine',
  'nextActionText',
  'nextActionDate',
  'expectedCloseDate',
  'ownerId'
]);

/**
 * Messages for one field.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: string): string[] {
  const message = messages.value[field];
  return message === undefined ? [] : [message];
}

/**
 * Parse the amount input as pounds and pence.
 *
 * @param text The input.
 * @returns Minor units, or `null` when invalid.
 */
function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/[£,\s]/gu, '');
  if (trimmed === '') {
    return 0;
  }
  if (!/^\d+(?:\.\d{1,2})?$/u.test(trimmed)) {
    return null;
  }
  return Math.round(Number(trimmed) * 100);
}

/**
 * Validate the obvious rules locally, then emit.
 */
function onSubmit(): void {
  const errors: Record<string, string> = {};
  if (draft.title.trim() === '') {
    errors.title = 'Title is required.';
  }
  if (draft.contact === null) {
    errors.primaryContactId = 'Choose the primary contact.';
  }
  const amountMinor = parseAmount(draft.amount);
  if (amountMinor === null) {
    errors.amountMinor = 'Enter an amount in pounds, e.g. 1250 or 1250.50.';
  }
  const actionText = closed.value ? '' : draft.nextActionText.trim();
  const actionDate = closed.value ? '' : draft.nextActionDate;
  if ((actionText === '') !== (actionDate === '')) {
    errors.nextActionDate = 'A next action needs both a description and a date.';
  }
  localErrors.value = errors;
  if (
    !validation.submit()
    || Object.keys(errors).length > 0
    || draft.contact === null
    || amountMinor === null
  ) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  emit('submit', {
    title: draft.title,
    contact: draft.contact,
    withCompany: draft.withCompany,
    stageId: draft.stageId,
    status: draft.status,
    amountMinor,
    statusLine: draft.statusLine,
    nextActionText: actionText,
    nextActionDate: actionDate,
    expectedCloseDate: draft.expectedCloseDate,
    ownerId: draft.ownerId
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
  <v-form novalidate aria-labelledby="deal-form-title" @submit.prevent="onSubmit">
    <div
      v-if="formError || Object.keys(messages).length > 0 || hiddenErrors.length > 0"
      ref="summary"
      tabindex="-1"
      class="mb-4"
      data-testid="form-summary"
    >
      <v-alert type="error" variant="tonal" role="alert">
        <div>{{ formError ?? 'Please correct the highlighted fields.' }}</div>
        <div v-for="message in hiddenErrors" :key="message">{{ message }}</div>
      </v-alert>
    </div>
    <v-row density="compact">
      <v-col cols="12">
        <v-text-field
          v-model="draft.title"
          @blur="validation.blur('title')"
          label="Title"
          required
          :error-messages="errorsFor('title')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <ContactPicker
          v-model="draft.contact"
          label="Primary contact"
          :error-messages="errorsFor('primaryContactId')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-checkbox
          v-model="draft.withCompany"
          label="File under the contact’s company"
          hide-details
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-select
          v-model="draft.status"
          :items="statusItems"
          label="Outcome"
          :error-messages="errorsFor('status')"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-select
          v-model="draft.stageId"
          :items="stages"
          item-title="label"
          item-value="id"
          label="Stage"
          :error-messages="errorsFor('stageId')"
        />
      </v-col>
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="draft.amount"
          @blur="validation.blur('amountMinor')"
          label="Amount (£)"
          inputmode="decimal"
          :error-messages="errorsFor('amountMinor')"
        />
      </v-col>
      <v-col cols="12">
        <v-text-field
          v-model="draft.statusLine"
          @blur="validation.blur('statusLine')"
          label="Status line"
          hint="Free text for people, e.g. “Waiting for contract sign”. Not used for reporting."
          persistent-hint
          counter="160"
          :error-messages="errorsFor('statusLine')"
        />
      </v-col>
      <template v-if="!closed">
        <v-col cols="12" sm="8">
          <v-text-field
            v-model="draft.nextActionText"
            @blur="validation.blur('nextActionText')"
            label="Next action"
            counter="140"
            :error-messages="errorsFor('nextActionText')"
          />
        </v-col>
        <v-col cols="12" sm="4">
          <v-text-field
            v-model="draft.nextActionDate"
            @blur="validation.blur('nextActionDate')"
            label="Next action date"
            type="date"
            :error-messages="errorsFor('nextActionDate')"
          />
        </v-col>
      </template>
      <v-col v-else cols="12">
        <p class="text-body-2 text-medium-emphasis">
          A won or lost deal has no next action; saving clears it.
        </p>
      </v-col>
      <v-col cols="12" sm="6">
        <v-text-field
          v-model="draft.expectedCloseDate"
          @blur="validation.blur('expectedCloseDate')"
          label="Expected close date"
          type="date"
          :error-messages="errorsFor('expectedCloseDate')"
        />
      </v-col>
      <v-col cols="12" sm="6">
        <v-select
          v-model="draft.ownerId"
          :items="assignees"
          item-title="displayName"
          item-value="id"
          label="Owner"
          :disabled="!canAssign"
          :hint="canAssign ? '' : 'Only managers and owners can assign deals to someone else.'"
          persistent-hint
          :error-messages="errorsFor('ownerId')"
        />
      </v-col>
    </v-row>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">{{
        deal ? 'Save deal' : 'Create deal'
      }}</v-btn>
    </div>
  </v-form>
</template>
