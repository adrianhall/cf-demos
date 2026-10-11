<script setup lang="ts">
/**
 * Invite a teammate, or change an existing teammate's roles.
 *
 * A composition of Vuetify form primitives: text fields for the e-mail and display name (invite
 * only) and one labelled checkbox per seeded role, each with a one-line description of what it
 * grants. Checkboxes rather than a multi-select so every role and its meaning is visible and
 * reachable with Tab and Space. The form owns its draft and keeps it after a failed save, like the
 * other editors, so a version conflict or "keep one owner" refusal does not lose the user's
 * choice.
 *
 * @fires submit With the draft.
 * @fires cancel When the user cancels.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import {
  InviteUserInputSchema,
  SetUserRolesInputSchema,
  type RoleDefinition,
  type TeamMember
} from '../../shared/api/team.ts';
import type { Role } from '../../shared/permissions.ts';
import { useFieldValidation } from '../composables/useFieldValidation.ts';
import type { TeamMemberFormValue } from '../services/team-draft.ts';

const props = defineProps<{
  /**
   * The teammate being edited; absent when inviting.
   */
  member?: TeamMember | null;
  /**
   * The role catalogue.
   */
  roles: readonly RoleDefinition[];
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
  submit: [value: TeamMemberFormValue];
  /**
   * The user cancelled.
   */
  cancel: [];
}>();

/**
 * What each role is for, in plain words.
 */
const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  'owner': 'Everything, including the team, roles, and the audit trail.',
  'manager': 'All sales and delivery work, reassigning, archiving, and the audit trail.',
  'sales': 'Contacts, companies, deals, activities, conversion, and notes.',
  'delivery': 'Project tasks and notes; reads everything else.',
  'read-only': 'Reads everything; changes nothing.'
};

const draft = reactive<TeamMemberFormValue>({
  email: '',
  displayName: '',
  roles: props.member ? props.member.roles.map((role) => role.id) : ['read-only']
});
const localErrors = ref<Record<string, string>>({});
const summary = ref<HTMLElement | null>(null);
const inviting = computed(() => !props.member);
const validation = useFieldValidation(
  inviting.value ? InviteUserInputSchema : SetUserRolesInputSchema,
  () => (inviting.value ? { ...draft, email: draft.email.trim() } : { roles: draft.roles })
);

/**
 * Messages for one field, local first.
 *
 * @param field Field name.
 * @returns Messages for Vuetify's `error-messages`.
 */
function errorsFor(field: string): string[] {
  const message =
    localErrors.value[field] ?? validation.errors.value[field] ?? props.fieldErrors?.[field];
  return message === undefined ? [] : [message];
}

/**
 * Validate locally, then emit.
 */
function onSubmit(): void {
  const errors: Record<string, string> = {};
  if (inviting.value) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim())) {
      errors.email = 'Must be a valid e-mail address.';
    }
    if (draft.displayName.trim() === '') {
      errors.displayName = 'Display name is required.';
    }
  }
  if (draft.roles.length === 0) {
    errors.roles = 'Choose at least one role.';
  }
  localErrors.value = errors;
  if (!validation.submit() || Object.keys(errors).length > 0) {
    void nextTick(() => summary.value?.focus());
    return;
  }
  emit('submit', { email: draft.email, displayName: draft.displayName, roles: [...draft.roles] });
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
  <v-form novalidate @submit.prevent="onSubmit">
    <div
      v-if="
        formError
        || Object.keys(localErrors).length > 0
        || Object.keys(validation.errors.value).length > 0
        || Object.keys(fieldErrors ?? {}).length > 0
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
    <template v-if="inviting">
      <v-text-field
        v-model="draft.email"
        @blur="validation.blur('email')"
        label="Access e-mail"
        required
        type="email"
        autocomplete="off"
        hint="The address they sign in to Cloudflare Access with. No e-mail is sent."
        persistent-hint
        :disabled="submitting"
        :error-messages="errorsFor('email')"
        class="mb-3"
      />
      <v-text-field
        v-model="draft.displayName"
        @blur="validation.blur('displayName')"
        label="Display name"
        required
        counter="100"
        :disabled="submitting"
        :error-messages="errorsFor('displayName')"
        class="mb-2"
      />
    </template>
    <fieldset class="role-fieldset">
      <legend class="text-body-1 mb-1">Roles</legend>
      <p class="text-body-2 text-medium-emphasis mb-2">
        Permissions are the combination of every role chosen. Changes apply on their next request.
      </p>
      <v-checkbox
        v-for="role in roles"
        :key="role.id"
        v-model="draft.roles"
        :value="role.id"
        :label="role.label"
        :messages="[ROLE_DESCRIPTIONS[role.id]]"
        :disabled="submitting"
        density="compact"
        class="mb-1"
      />
      <div v-if="errorsFor('roles').length > 0" class="text-error text-body-2" role="alert">
        {{ errorsFor('roles')[0] }}
      </div>
    </fieldset>
    <div class="d-flex justify-end ga-2 mt-4">
      <v-btn variant="text" :disabled="submitting" @click="emit('cancel')">Cancel</v-btn>
      <v-btn type="submit" color="primary" :loading="submitting">{{
        inviting ? 'Add teammate' : 'Save roles'
      }}</v-btn>
    </div>
  </v-form>
</template>

<style scoped>
.role-fieldset {
  border: 0;
  margin: 0;
  min-width: 0;
  padding: 0;
}
</style>
