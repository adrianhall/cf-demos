<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
/**
 * Team: the directory of everyone who can sign in, their roles and status, and — for owners — the
 * controls to add a teammate, change roles, and suspend or reactivate an account.
 *
 * Built from Vuetify's `VDataTable` (sortable columns are off: the server orders by name and pages
 * with a cursor, so "Load more" appends), `VChip`, `VDialog`, and form primitives. Managers see the
 * directory read-only. Capability hints only decide which controls appear; every change is
 * authorized by the Data Worker, and a refusal (for example removing the last owner) is shown in
 * the dialog with the user's choice kept.
 */
import { mdiAccountPlus, mdiMagnify } from '@mdi/js';
import type { RoleDefinition, TeamMember } from '../../shared/api/team.ts';
import ResourceState from '../components/ResourceState.vue';
import TeamMemberForm from '../components/TeamMemberForm.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { useSession } from '../composables/useSession.ts';
import { useSubmission } from '../composables/useSubmission.ts';
import { api, ApiError } from '../services/api-client.ts';
import { type TeamMemberFormValue, toInviteInput, toRolesInput } from '../services/team-draft.ts';

const { can, session, reload } = useSession();
const format = useFormat();
const canManage = computed(() => can('users.manage') && can('roles.assign'));

const search = ref('');
const members = shallowRef<TeamMember[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const directory = useResource(async (signal) => {
  const page = await api.team(search.value.trim() === '' ? {} : { q: search.value.trim() }, signal);
  members.value = [...page.items];
  nextCursor.value = page.nextCursor;
  return page;
});
const roles = shallowRef<RoleDefinition[]>([]);
const rolesError = shallowRef<string | null>(null);

/**
 * Load the role catalogue independently of the directory, with a retryable failure. A failed
 * catalogue must not masquerade as an empty role list.
 */
async function loadRoles(): Promise<void> {
  rolesError.value = null;
  try {
    roles.value = await api.roles();
  } catch (caught) {
    roles.value = [];
    rolesError.value =
      caught instanceof ApiError ? caught.message : 'Could not load the available roles.';
  }
}

const headers = [
  { title: 'Name', key: 'displayName', sortable: false },
  { title: 'E-mail', key: 'email', sortable: false },
  { title: 'Roles', key: 'roles', sortable: false },
  { title: 'Status', key: 'status', sortable: false },
  { title: 'Since', key: 'createdAt', sortable: false },
  { title: 'Actions', key: 'actions', sortable: false, align: 'end' as const }
];

let debounce: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(debounce));
watch(search, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void directory.load(), 250);
});

/**
 * Append the next page.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  loadingMore.value = true;
  try {
    const page = await api.team({
      ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
      cursor: nextCursor.value
    });
    members.value = [...members.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

/**
 * Replace one member in the loaded list.
 *
 * @param member The updated member.
 */
function replace(member: TeamMember): void {
  members.value = members.value.map((item) => (item.id === member.id ? member : item));
}

const dialog = ref<'invite' | 'roles' | null>(null);
const editing = shallowRef<TeamMember | null>(null);
const submission = useSubmission({
  forbidden: 'Only an owner can change the team.',
  conflict:
    'This teammate was changed by someone else. Close this dialog to see the latest version.'
});

/**
 * Open the invite dialog.
 */
function openInvite(): void {
  submission.reset();
  editing.value = null;
  dialog.value = 'invite';
}

/**
 * Open the role editor for a teammate.
 *
 * @param member The teammate.
 */
function openRoles(member: TeamMember): void {
  submission.reset();
  editing.value = member;
  dialog.value = 'roles';
}

/**
 * Save the dialog's draft.
 *
 * @param value The draft.
 */
async function save(value: TeamMemberFormValue): Promise<void> {
  const target = editing.value;
  const saved = await submission.run((key) =>
    target === null
      ? api.inviteUser(toInviteInput(value), key)
      : api.setUserRoles(target.id, toRolesInput(value), target.version, key)
  );
  if (saved === undefined) {
    return;
  }
  dialog.value = null;
  if (target === null) {
    members.value = [...members.value, saved].sort((a, b) =>
      a.displayName.toLowerCase() < b.displayName.toLowerCase() ? -1 : 1
    );
  } else {
    replace(saved);
    if (saved.id === session.value?.user.id) {
      // The owner changed their own roles: refresh capability hints now.
      await reload();
    }
  }
}

const statusError = ref<string | null>(null);
const confirming = shallowRef<TeamMember | null>(null);

/**
 * Suspend or reactivate after confirmation.
 */
async function toggleStatus(): Promise<void> {
  const member = confirming.value;
  if (member === null) {
    return;
  }
  statusError.value = null;
  const status = member.status === 'active' ? 'suspended' : 'active';
  const saved = await submission.run((key) =>
    api.setUserStatus(member.id, { status }, member.version, key)
  );
  confirming.value = null;
  if (saved === undefined) {
    statusError.value = submission.formError.value;
    return;
  }
  replace(saved);
}

/**
 * Ask before a status change.
 *
 * @param member The teammate.
 */
function askStatus(member: TeamMember): void {
  submission.reset();
  statusError.value = null;
  confirming.value = member;
}

onMounted(() => {
  void directory.load();
  void loadRoles();
});
</script>

<template>
  <section aria-labelledby="team-title">
    <div class="d-flex align-center justify-space-between flex-wrap ga-2 mb-1">
      <h1 id="team-title" class="text-h4">Team</h1>
      <v-btn
        v-if="canManage"
        color="primary"
        :prepend-icon="mdiAccountPlus"
        :disabled="roles.length === 0"
        @click="openInvite"
        >Add teammate</v-btn
      >
    </div>
    <p class="text-medium-emphasis mb-4">
      Everyone who can sign in, and what their roles let them do.
      <template v-if="!canManage">Only an owner can change the team.</template>
    </p>
    <v-alert v-if="rolesError" type="warning" variant="tonal" class="mb-4" role="alert">
      Roles could not be loaded. {{ rolesError }}
      <template #append><v-btn variant="text" @click="loadRoles">Retry roles</v-btn></template>
    </v-alert>
    <v-alert
      v-if="statusError"
      type="error"
      variant="tonal"
      class="mb-4"
      closable
      role="alert"
      @click:close="statusError = null"
      >{{ statusError }}</v-alert
    >
    <v-text-field
      v-model="search"
      label="Search by name or e-mail"
      :prepend-inner-icon="mdiMagnify"
      clearable
      class="mb-2"
      style="max-width: 480px"
    />
    <ResourceState
      :state="directory.state.value"
      :error="directory.error.value"
      :empty="members.length === 0"
      :has-data="directory.data.value !== null"
      skeleton="table"
      empty-title="No matching teammates"
      @retry="directory.load"
    >
      <v-card>
        <v-data-table
          :headers="headers"
          :items="members"
          item-value="id"
          :items-per-page="-1"
          hide-default-footer
          aria-label="Team members"
          mobile-breakpoint="0"
        >
          <template #[`item.displayName`]="{ item }">
            <span class="font-weight-medium">{{ item.displayName }}</span>
            <span v-if="item.id === session?.user.id" class="text-medium-emphasis"> (you)</span>
          </template>
          <template #[`item.roles`]="{ item }">
            <div class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="role in item.roles"
                :key="role.id"
                size="small"
                :color="role.id === 'owner' ? 'primary-strong' : 'secondary'"
                variant="tonal"
                >{{ role.label }}</v-chip
              >
            </div>
          </template>
          <template #[`item.status`]="{ item }">
            <v-chip
              size="small"
              :color="item.status === 'active' ? 'success' : undefined"
              variant="tonal"
              >{{ item.status === 'active' ? 'Active' : 'Suspended' }}</v-chip
            >
          </template>
          <template #[`item.createdAt`]="{ item }">{{ format.dateTime(item.createdAt) }}</template>
          <template #[`item.actions`]="{ item }">
            <div v-if="canManage" class="d-flex justify-end ga-1">
              <v-btn
                size="small"
                variant="text"
                :aria-label="`Change roles for ${item.displayName}`"
                @click="openRoles(item)"
                >Roles</v-btn
              >
              <v-btn
                v-if="item.id !== session?.user.id"
                size="small"
                variant="text"
                :color="item.status === 'active' ? 'error' : undefined"
                :aria-label="`${item.status === 'active' ? 'Suspend' : 'Reactivate'} ${item.displayName}`"
                @click="askStatus(item)"
                >{{ item.status === 'active' ? 'Suspend' : 'Reactivate' }}</v-btn
              >
            </div>
          </template>
        </v-data-table>
      </v-card>
      <div v-if="nextCursor" class="d-flex justify-center mt-2">
        <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
      </div>
    </ResourceState>

    <v-dialog
      :model-value="dialog !== null"
      max-width="560"
      aria-labelledby="team-form-title"
      scrollable
      @update:model-value="dialog = null"
    >
      <v-card>
        <v-card-title>
          <h2 id="team-form-title" class="text-h6">
            {{ dialog === 'invite' ? 'Add teammate' : `Roles for ${editing?.displayName ?? ''}` }}
          </h2>
        </v-card-title>
        <v-card-text>
          <TeamMemberForm
            v-if="dialog !== null"
            :member="editing"
            :roles="roles"
            :submitting="submission.submitting.value"
            :field-errors="submission.fieldErrors.value"
            :form-error="submission.formError.value"
            @submit="save"
            @cancel="dialog = null"
          />
        </v-card-text>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="confirming !== null"
      max-width="440"
      aria-labelledby="status-title"
      @update:model-value="confirming = null"
    >
      <v-card v-if="confirming">
        <v-card-title>
          <h2 id="status-title" class="text-h6">
            {{ confirming.status === 'active' ? 'Suspend' : 'Reactivate' }}
            {{ confirming.displayName }}?
          </h2>
        </v-card-title>
        <v-card-text>
          {{
            confirming.status === 'active'
              ? 'They will be refused on their next request. Their records stay as they are.'
              : 'They will be able to sign in again with their current roles.'
          }}
        </v-card-text>
        <v-card-actions class="justify-end">
          <v-btn variant="text" @click="confirming = null">Cancel</v-btn>
          <v-btn
            :color="confirming.status === 'active' ? 'error' : 'primary'"
            variant="flat"
            :loading="submission.submitting.value"
            @click="toggleStatus"
            >{{ confirming.status === 'active' ? 'Suspend' : 'Reactivate' }}</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>
