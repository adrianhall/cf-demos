<script setup lang="ts">
import type { Connection } from "@vue-flow/core";
import { onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramCanvas from "../components/diagrams/DiagramCanvas.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramPalette from "../components/diagrams/DiagramPalette.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import PropertiesPanel from "../components/diagrams/PropertiesPanel.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../components/FeatherIcon.vue";
import { useDiagramDocumentStore } from "../stores/diagram-document";

/** `/app/diagrams/:id` — the focused Vue Flow architecture editor for one diagram. */
const route = useRoute();
const router = useRouter();
const store = useDiagramDocumentStore();

/** (Re)load the diagram named by the current route param. */
async function loadCurrent(): Promise<void> {
  await store.load(String(route.params.id));
}

onMounted(loadCurrent);
// Vue Router does not remount this component when only the `:id` param changes between two
// diagrams — see the `vue-router-best-practices` skill's route-param-change lifecycle guidance —
// so reload explicitly whenever it does.
watch(() => route.params.id, loadCurrent);

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

/** Return to the diagram library. */
function backToLibrary(): void {
  router.push({ name: "diagram-library" });
}
</script>

<template>
  <div class="editor-shell">
    <header class="toolbar">
      <v-btn variant="text" @click="backToLibrary">
        <template #prepend><FeatherIcon name="folder" /></template>
        Diagrams
      </v-btn>
      <h1 class="title">{{ store.diagram?.title ?? "Loading…" }}</h1>
      <v-spacer />
      <v-chip v-if="store.pending" size="small">Saving…</v-chip>
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
      Someone changed this diagram since your last view. It has been refreshed — please retry
      your edit.
    </v-alert>
    <v-alert v-if="store.error" type="error" variant="tonal">{{ store.error }}</v-alert>

    <v-progress-circular v-if="store.loading" color="primary" indeterminate />

    <section v-else-if="store.document" class="editor">
      <DiagramPalette />
      <DiagramCanvas
        :edges="store.document.edges"
        :nodes="store.document.nodes"
        @clear-selection="store.selectNothing()"
        @connect-nodes="handleConnect"
        @move-node="store.moveNode"
        @select-edge="(id) => store.select('edge', id)"
        @select-node="(id) => store.select('node', id)"
      />
      <PropertiesPanel />
    </section>
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
  gap: 0.75rem;
  padding: 0.75rem 1rem;
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
@media (max-width: 900px) {
  .editor {
    grid-template-columns: 1fr;
  }
}
</style>
