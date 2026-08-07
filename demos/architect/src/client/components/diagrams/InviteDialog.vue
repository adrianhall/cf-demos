<script setup lang="ts">
import { computed, watch } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";
import { useDiagramInvitationsStore } from "../../stores/diagram-invitations";

/**
 * Owner-only dialog for creating, copying, and revoking a diagram's editor invitations.
 *
 * `DiagramEditorView.vue` renders this only when the signed-in identity owns the open diagram —
 * an editor never even sees the trigger that opens it — but every action here still goes through
 * the Worker's own owner-only `DiagramRepository.requireOwner()` check, so this component is a
 * UI convenience, not the authorization boundary.
 */
const props = defineProps<{
  /** Diagram to manage invitations for. */
  diagramId: string;
}>();
const open = defineModel<boolean>("open", { default: false });

const store = useDiagramInvitationsStore();

/** The most recently created invitation's shareable link, or empty before one exists. */
const inviteLink = computed(() =>
  store.lastCreatedToken
    ? `${window.location.origin}/app/invitations/${store.lastCreatedToken}`
    : "",
);

// Load the diagram's active invitations fresh every time the dialog opens, and forget any
// previous session's one-time raw token so it never lingers past its own dialog visit.
watch(open, (isOpen) => {
  if (isOpen) {
    store.clearLastCreatedToken();
    void store.load(props.diagramId);
  }
});

/** Create a new invitation for this diagram. */
async function createInvitation(): Promise<void> {
  await store.create(props.diagramId);
}

/** Copy the most recently created invitation's link to the clipboard. */
async function copyLink(): Promise<void> {
  if (inviteLink.value) {
    await navigator.clipboard.writeText(inviteLink.value);
  }
}

/** Revoke one invitation. */
async function revoke(invitationId: string): Promise<void> {
  await store.revoke(props.diagramId, invitationId);
}
</script>

<template>
  <v-dialog v-model="open" max-width="640">
    <v-card title="Invite a collaborator">
      <v-card-text>
        <p class="hint">
          Anyone with this link can sign in with Cloudflare Access and gain durable editor access
          to this diagram. Each link is single-use and expires automatically.
        </p>

        <v-btn color="primary" :loading="store.creating" @click="createInvitation">
          <template #prepend><FeatherIcon name="user-plus" /></template>
          Create invitation link
        </v-btn>

        <div v-if="inviteLink" class="invite-link" role="status">
          <code>{{ inviteLink }}</code>
          <v-btn size="small" variant="text" @click="copyLink">
            <template #prepend><FeatherIcon name="copy" /></template>
            Copy link
          </v-btn>
        </div>

        <v-alert v-if="store.error" class="mt-3" type="error" variant="tonal">
          {{ store.error }}
        </v-alert>

        <h2 class="subhead">Active invitations</h2>
        <v-progress-circular v-if="store.loading" indeterminate color="primary" size="20" width="2" />
        <p v-else-if="store.invitations.length === 0" class="empty">No active invitations.</p>
        <v-list v-else aria-label="Active invitations">
          <v-list-item v-for="invitation in store.invitations" :key="invitation.id">
            <template #title>
              Expires {{ new Date(invitation.expiresAt).toLocaleString() }}
            </template>
            <template #append>
              <v-btn
                :aria-label="`Revoke invitation expiring ${new Date(invitation.expiresAt).toLocaleString()}`"
                size="small"
                variant="text"
                @click="revoke(invitation.id)"
              >
                <FeatherIcon name="trash-2" />
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
  margin-bottom: 1rem;
}
.invite-link {
  align-items: center;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  margin-top: 1rem;
  padding: 0.5rem 0.75rem;
}
.invite-link code {
  overflow-wrap: anywhere;
}
.subhead {
  font-size: 1rem;
  margin: 1.5rem 0 0.5rem;
}
.empty {
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>
