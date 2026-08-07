<script setup lang="ts">
import type { Connection } from "@vue-flow/core";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramCanvas from "../components/diagrams/DiagramCanvas.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramPalette from "../components/diagrams/DiagramPalette.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import InviteDialog from "../components/diagrams/InviteDialog.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import MemberList from "../components/diagrams/MemberList.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import PropertiesPanel from "../components/diagrams/PropertiesPanel.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../components/FeatherIcon.vue";
import { useDiagramDocumentStore } from "../stores/diagram-document";
import { useSessionStore } from "../stores/session";

/** `/app/diagrams/:id` — the focused Vue Flow architecture editor for one diagram. */
const route = useRoute();
const router = useRouter();
const store = useDiagramDocumentStore();
const session = useSessionStore();
const inviteDialogOpen = ref(false);

/**
 * Whether the signed-in identity owns the open diagram.
 *
 * Only the owner may invite collaborators (`docs/09-ARCHITECT.md`'s Phase 3 rule) — this drives
 * whether the toolbar's Invite control and `InviteDialog.vue` render at all. The Worker enforces
 * the same boundary independently (`DiagramRepository.requireOwner()`), so hiding the control
 * here is a UI convenience, not the authorization boundary.
 */
const isOwner = computed(
  () => !!store.diagram && store.diagram.ownerEmail === session.email,
);

/** Every other connected participant, excluding the signed-in identity's own connection. */
const otherParticipants = computed(() =>
  store.participants.filter(
    (participant) => participant.email !== session.email,
  ),
);

/** Icon reflecting the live connection's current lifecycle state. */
const connectionIcon = computed(() => {
  switch (store.connectionStatus) {
    case "connected":
      return "wifi";
    case "error":
      return "alert-triangle";
    default:
      return "wifi-off";
  }
});

/**
 * A single, always-up-to-date sentence describing the collaboration state for an `aria-live`
 * region (`docs/09-ARCHITECT.md`'s Phase 4 accessibility requirement) — sighted users see the
 * same information through the toolbar's connection chip and participant list, plus the
 * stale/error `v-alert`s below.
 */
const liveAnnouncement = computed(() => {
  if (store.connectionStatus === "connecting") {
    return "Connecting to the diagram…";
  }
  if (store.connectionStatus === "reconnecting") {
    return "Reconnecting…";
  }
  if (store.connectionStatus === "error") {
    return "A connection error occurred. Reload the page to keep collaborating.";
  }
  if (store.staleNotice) {
    return "Your edit conflicted with a more recent change and was not applied. The diagram has been refreshed — please retry.";
  }
  if (store.error) {
    return store.error;
  }
  if (store.connectionStatus === "connected") {
    const count = otherParticipants.value.length;
    return count > 0
      ? `Connected — editing with ${count} other ${count === 1 ? "person" : "people"}.`
      : "Connected.";
  }
  return "";
});

/** (Re)load the diagram named by the current route param. */
async function loadCurrent(): Promise<void> {
  await store.load(String(route.params.id));
}

onMounted(async () => {
  await session.load();
  await loadCurrent();
});
// Vue Router does not remount this component when only the `:id` param changes between two
// diagrams — see the `vue-router-best-practices` skill's route-param-change lifecycle guidance —
// so reload explicitly whenever it does.
watch(() => route.params.id, loadCurrent);
// Close the live WebSocket when navigating away — an intentional disconnect never reconnects
// (`../composables/useDiagramSocket.ts`), unlike an unexpected drop while this view is mounted.
onUnmounted(() => store.disconnect());

/** Create a new default `request` edge for a connection the user drew on the canvas. */
async function handleConnect(connection: Connection): Promise<void> {
  await store.addEdge({
    id: `edge-${crypto.randomUUID()}`,
    source: connection.source,
    target: connection.target,
    type: "request",
    data: { relationship: "request", label: "request" },
  });
}

/** Forward the local pointer's graph-space position (and current selection) to the room. */
function handleCursorMove(x: number, y: number): void {
  store.sendCursor(x, y, store.selection);
}

/** Return to the diagram library. */
function backToLibrary(): void {
  router.push({ name: "diagram-library" });
}
</script>

<template>
  <div class="editor-shell">
    <!-- Visually hidden, always present: announces connection/conflict state to screen readers,
    per docs/09-ARCHITECT.md's Phase 4 accessibility requirement. Sighted users see the same
    information through the connection chip, participant list, and v-alerts below. -->
    <div aria-live="polite" class="sr-only" role="status">{{ liveAnnouncement }}</div>

    <header class="toolbar">
      <v-btn variant="text" @click="backToLibrary">
        <template #prepend><FeatherIcon name="folder" /></template>
        Diagrams
      </v-btn>
      <h1 class="title">{{ store.diagram?.title ?? "Loading…" }}</h1>
      <v-spacer />
      <v-chip
        :color="store.connectionStatus === 'connected' ? 'success' : undefined"
        :title="liveAnnouncement"
        size="small"
      >
        <template #prepend><FeatherIcon :name="connectionIcon" /></template>
        {{ store.connectionStatus }}
      </v-chip>
      <div v-if="otherParticipants.length > 0" aria-label="Other collaborators editing this diagram" class="participants">
        <v-chip
          v-for="participant in otherParticipants"
          :key="participant.email"
          :color="participant.role === 'owner' ? 'primary' : undefined"
          size="small"
          variant="tonal"
        >
          {{ participant.email }}
        </v-chip>
      </div>
      <v-chip v-if="store.pending" size="small">Saving…</v-chip>
      <v-btn v-if="isOwner" variant="text" @click="inviteDialogOpen = true">
        <template #prepend><FeatherIcon name="user-plus" /></template>
        Invite
      </v-btn>
      <!--
        Unconditionally rendered, even while the current identity may be the wrong one: this is
        the only recovery available in local development if the wrong dev identity was selected
        (docs/09-ARCHITECT.md's Access Model / this repository's Public Access convention).
      -->
      <v-btn variant="text" href="/cdn-cgi/access/logout">
        <template #prepend><FeatherIcon name="log-out" /></template>
        Sign out
      </v-btn>
    </header>

    <v-alert
      v-if="store.staleNotice"
      closable
      type="warning"
      variant="tonal"
      @click:close="store.dismissStaleNotice()"
    >
      Your edit conflicted with a more recent change and was not applied. The diagram has been
      refreshed — please retry your edit.
    </v-alert>
    <v-alert v-if="store.error" type="error" variant="tonal">{{ store.error }}</v-alert>
    <v-alert v-if="store.connectionStatus === 'error'" type="error" variant="tonal">
      A connection error occurred. Reload the page to keep collaborating.
    </v-alert>

    <v-progress-circular v-if="store.loading" color="primary" indeterminate />

    <section v-else-if="store.document" class="editor">
      <DiagramPalette />
      <DiagramCanvas
        :edges="store.document.edges"
        :nodes="store.document.nodes"
        :remote-cursors="store.remoteCursorList"
        @clear-selection="store.selectNothing()"
        @connect-nodes="handleConnect"
        @cursor-move="handleCursorMove"
        @move-node="store.moveNode"
        @select-edge="(id) => store.select('edge', id)"
        @select-node="(id) => store.select('node', id)"
      />
      <div class="side-panel">
        <PropertiesPanel />
        <MemberList v-if="store.diagram" :diagram-id="store.diagram.id" />
      </div>
    </section>

    <InviteDialog
      v-if="store.diagram"
      v-model:open="inviteDialogOpen"
      :diagram-id="store.diagram.id"
    />
  </div>
</template>

<style scoped>
.editor-shell {
  display: flex;
  flex-direction: column;
  min-block-size: 100vh;
}
.toolbar {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
}
.participants {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.sr-only {
  block-size: 1px;
  clip: rect(0, 0, 0, 0);
  overflow: hidden;
  position: absolute;
  inline-size: 1px;
}
.title {
  font-size: 1.1rem;
  margin: 0;
}
.editor {
  display: grid;
  flex: 1;
  grid-template-columns: 16rem minmax(20rem, 1fr) 18rem;
}
.side-panel {
  display: flex;
  flex-direction: column;
  min-block-size: 0;
  overflow-y: auto;
}
@media (max-width: 900px) {
  .editor {
    grid-template-columns: 1fr;
  }
}
</style>
