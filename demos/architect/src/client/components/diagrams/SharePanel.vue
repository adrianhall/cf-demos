<script setup lang="ts">
import { computed, watch } from "vue";
import { useDiagramShareStore } from "../../stores/diagram-share";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";

/**
 * Owner-only dialog for publishing, republishing, revoking, and copying a diagram's public
 * read-only share link (`docs/09-ARCHITECT.md`'s Phase 6).
 *
 * `DiagramEditorView.vue` renders this only when the signed-in identity owns the open diagram —
 * mirroring `InviteDialog.vue`'s owner-only visibility pattern — but every action here still goes
 * through the Worker's own owner-only `DiagramRepository.requireOwner()` check, so this
 * component is a UI convenience, not the authorization boundary.
 */
const props = defineProps<{
  /** Diagram to manage publication for. */
  diagramId: string;
}>();
const open = defineModel<boolean>("open", { default: false });

const store = useDiagramShareStore();

/**
 * The share link for this diagram, built only from a raw token this session actually has —
 * either just returned by a first publish, or never shown again after a page reload
 * (`./diagram-share.ts`'s `lastToken` documentation explains why the server cannot reveal it a
 * second time). The link's capability lives in the URL *fragment*, after `#`, so it is never
 * sent in an HTTP request or appear in a server/proxy access log.
 */
const shareLink = computed(() =>
  store.lastToken ? `${window.location.origin}/share#${store.lastToken}` : "",
);

// Load the diagram's current status fresh every time the dialog opens, and forget any previous
// session's one-time raw token so it never lingers past its own dialog visit.
watch(open, (isOpen) => {
  if (isOpen) {
    store.clearLastToken();
    void store.load(props.diagramId);
  }
});

/** Publish (or republish) this diagram's current document. */
async function publish(): Promise<void> {
  await store.publish(props.diagramId);
}

/** Copy the current share link to the clipboard. */
async function copyLink(): Promise<void> {
  if (shareLink.value) {
    await navigator.clipboard.writeText(shareLink.value);
  }
}

/** Revoke this diagram's active share. */
async function revoke(): Promise<void> {
  await store.revoke(props.diagramId);
}
</script>

<template>
  <v-dialog v-model="open" max-width="640">
    <v-card title="Publish a read-only link">
      <v-card-text>
        <p class="hint">
          Anyone with this link can view a read-only snapshot of this diagram — no sign-in, no
          editing, and no live collaboration. Republishing updates the same link to the diagram's
          current content.
        </p>

        <v-btn color="primary" :loading="store.publishing" @click="publish">
          <template #prepend><FeatherIcon name="globe" /></template>
          {{ store.status?.published ? "Republish current version" : "Publish this diagram" }}
        </v-btn>

        <div v-if="shareLink" class="share-link" role="status">
          <code>{{ shareLink }}</code>
          <v-btn size="small" variant="text" @click="copyLink">
            <template #prepend><FeatherIcon name="copy" /></template>
            Copy link
          </v-btn>
        </div>
        <p v-else-if="store.status?.published" class="hint">
          Published at revision {{ store.status.revision }}. The link was shown once, when this
          diagram was first published — revoke and republish to get a new one if it was lost.
        </p>

        <v-alert v-if="store.error" class="mt-3" type="error" variant="tonal">
          {{ store.error }}
        </v-alert>

        <v-progress-circular v-if="store.loading" indeterminate color="primary" size="20" width="2" />

        <v-btn
          v-if="store.status?.published"
          class="mt-3"
          color="error"
          variant="text"
          @click="revoke"
        >
          <template #prepend><FeatherIcon name="trash-2" /></template>
          Revoke published link
        </v-btn>
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
.share-link {
  align-items: center;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 4px;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  margin-top: 1rem;
  padding: 0.5rem 0.75rem;
}
.share-link code {
  overflow-wrap: anywhere;
}
</style>
