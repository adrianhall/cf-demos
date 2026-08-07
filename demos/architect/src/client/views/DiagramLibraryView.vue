<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRouter } from "vue-router";
import type { BlueprintId } from "../../graph/blueprints";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import CreateDiagramDialog from "../components/diagrams/CreateDiagramDialog.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../components/FeatherIcon.vue";
import { useDiagramsStore } from "../stores/diagrams";
import { useSessionStore } from "../stores/session";

/**
 * `/app/diagrams` — the authenticated diagram library: list, create, rename, and open.
 *
 * `/app` itself is a router redirect to this view (see `main.ts`) rather than its own page —
 * Phase 1's empty shell had nothing else to show at `/app` once a real library exists, and a
 * separate always-empty landing step between sign-in and the library would add a click with no
 * content of its own.
 */
const session = useSessionStore();
const diagrams = useDiagramsStore();
const router = useRouter();
const {
  email,
  error: sessionError,
  loading: sessionLoading,
} = storeToRefs(session);
const greeting = computed(() =>
  email.value
    ? `Signed in as ${email.value}`
    : "Confirming your Access identity",
);

const createDialogOpen = ref(false);
const createPending = ref(false);
const createError = ref("");
const renamingId = ref("");
const renameTitle = ref("");
const renameError = ref("");

onMounted(async () => {
  await session.load();
  await diagrams.load();
});

/** Create a diagram from the dialog's form values, then open it. */
async function createDiagram(
  title: string,
  blueprintId: BlueprintId,
): Promise<void> {
  createPending.value = true;
  createError.value = "";
  try {
    const diagram = await diagrams.create(title, blueprintId);
    createDialogOpen.value = false;
    await router.push({ name: "diagram-editor", params: { id: diagram.id } });
  } catch (error) {
    createError.value =
      error instanceof Error ? error.message : "Could not create the diagram.";
  } finally {
    createPending.value = false;
  }
}

/** Begin inline renaming of one diagram. */
function startRename(id: string, currentTitle: string): void {
  renamingId.value = id;
  renameTitle.value = currentTitle;
  renameError.value = "";
}

/** Persist an inline rename and close the rename field on success. */
async function saveRename(): Promise<void> {
  if (!renameTitle.value.trim()) {
    return;
  }
  try {
    await diagrams.rename(renamingId.value, renameTitle.value.trim());
    renamingId.value = "";
  } catch (error) {
    renameError.value =
      error instanceof Error ? error.message : "Could not rename the diagram.";
  }
}

/** Always provide an Access logout path, including when identity verification fails. */
function signOut(): void {
  window.location.assign("/cdn-cgi/access/logout");
}
</script>

<template>
  <v-container class="library">
    <header class="header">
      <div>
        <p class="eyebrow">Architect</p>
        <h1>Diagram library</h1>
        <p v-if="sessionLoading" class="subtitle"><v-progress-circular indeterminate size="16" width="2" /></p>
        <p v-else-if="sessionError" class="subtitle error" role="alert">{{ sessionError }}</p>
        <p v-else class="subtitle">{{ greeting }}</p>
      </div>
      <div class="header-actions">
        <v-btn color="primary" @click="createDialogOpen = true">
          <template #prepend><FeatherIcon name="plus" /></template>
          New diagram
        </v-btn>
        <v-btn variant="text" @click="signOut">
          <template #prepend><FeatherIcon name="log-out" /></template>
          Sign out
        </v-btn>
      </div>
    </header>

    <v-alert v-if="diagrams.error" class="mb-4" type="error" variant="tonal">{{ diagrams.error }}</v-alert>

    <v-progress-circular v-if="diagrams.loading" indeterminate color="primary" />

    <v-card v-else-if="diagrams.diagrams.length === 0" class="empty-state" variant="outlined">
      <v-card-text>
        <FeatherIcon name="folder" :size="32" />
        <p>No diagrams yet. Create one to begin the demonstration.</p>
      </v-card-text>
    </v-card>

    <v-list v-else aria-label="Owned diagrams" lines="two">
      <v-list-item v-for="diagram in diagrams.diagrams" :key="diagram.id" class="diagram-item">
        <template #title>
          <template v-if="renamingId === diagram.id">
            <v-text-field
              v-model="renameTitle"
              autofocus
              density="compact"
              hide-details
              @keyup.enter="saveRename"
              @keyup.escape="renamingId = ''"
            />
          </template>
          <RouterLink v-else :to="{ name: 'diagram-editor', params: { id: diagram.id } }">
            {{ diagram.title }}
          </RouterLink>
        </template>
        <template #subtitle>
          Updated {{ new Date(diagram.updatedAt).toLocaleString() }}
        </template>
        <template #append>
          <div v-if="renamingId === diagram.id" class="d-flex ga-1">
            <v-btn :aria-label="`Save title for ${diagram.title}`" size="small" variant="text" @click="saveRename">
              <FeatherIcon name="check" />
            </v-btn>
            <v-btn :aria-label="`Cancel renaming ${diagram.title}`" size="small" variant="text" @click="renamingId = ''">
              <FeatherIcon name="x" />
            </v-btn>
          </div>
          <v-btn
            v-else
            :aria-label="`Rename ${diagram.title}`"
            size="small"
            variant="text"
            @click="startRename(diagram.id, diagram.title)"
          >
            <FeatherIcon name="edit-2" />
          </v-btn>
        </template>
      </v-list-item>
    </v-list>
    <v-alert v-if="renameError" class="mt-3" type="error" variant="tonal">{{ renameError }}</v-alert>

    <CreateDiagramDialog
      v-model:open="createDialogOpen"
      v-model:pending="createPending"
      @create="createDiagram"
    />
    <v-alert v-if="createError" class="mt-3" type="error" variant="tonal">{{ createError }}</v-alert>
  </v-container>
</template>

<style scoped>
.library {
  max-width: 1100px;
  padding-block: 3rem;
}
.header {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
  margin-bottom: 2rem;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
}
.eyebrow {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
}
.subtitle {
  color: rgb(var(--v-theme-on-surface-variant));
}
.subtitle.error {
  color: rgb(var(--v-theme-error));
}
.empty-state {
  border-style: dashed;
  min-height: 200px;
  padding: 2rem;
  text-align: center;
}
.diagram-item {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
}
</style>
