<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { getProduct } from "../../graph/catalog";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import DiagramCanvas from "../components/diagrams/DiagramCanvas.vue";
import { useSharedViewerStore } from "../stores/shared-viewer";

/**
 * `/share` — the anonymous, read-only public diagram viewer (`docs/09-ARCHITECT.md`'s Phase 6).
 *
 * Deliberately distinct from `InvitationRedeemView.vue`'s protected `/app/invitations/:token`
 * route: this page requires no Cloudflare Access identity at all (`/^\/share(?:\/|$)/u` in
 * `../../access-policies.ts` is `authenticate: false`) and never opens the live collaboration
 * WebSocket or reads any editable `DiagramRoom` state — it renders exactly the immutable snapshot
 * `POST /shared/resolve` returns, using `DiagramCanvas.vue`'s existing `readOnly` prop from
 * Phase 2/4 rather than a second canvas component. The capability lives entirely in this URL's
 * fragment (after `#`), which browsers never send in a request or a `Referer` header — this
 * component reads it once, client-side, and forwards it only in a same-origin JSON body.
 */
const store = useSharedViewerStore();
const selection = ref<{ kind: "node" | "edge"; id: string } | null>(null);

const selectedNode = computed(() => {
  if (selection.value?.kind !== "node" || !store.document) {
    return undefined;
  }
  return store.document.nodes.find((node) => node.id === selection.value?.id);
});
const selectedEdge = computed(() => {
  if (selection.value?.kind !== "edge" || !store.document) {
    return undefined;
  }
  return store.document.edges.find((edge) => edge.id === selection.value?.id);
});

onMounted(async () => {
  // The share token lives only in the URL fragment, never sent to any server by the browser
  // itself — this is the one and only place this component reads it.
  const token = window.location.hash.replace(/^#/u, "");
  if (!token) {
    store.error = "No share link was provided.";
    return;
  }
  await store.resolve(token);
});
</script>

<template>
  <div class="viewer">
    <header class="toolbar">
      <p class="eyebrow">Read-only diagram</p>
      <h1 class="title">{{ store.title || "Architect" }}</h1>
    </header>

    <v-progress-circular v-if="store.loading" color="primary" indeterminate class="ma-8" />
    <v-alert v-else-if="store.error" type="error" variant="tonal" class="ma-8">
      <template #title>This diagram is not available</template>
      {{ store.error }}
    </v-alert>

    <section v-else-if="store.document" class="canvas-wrap">
      <DiagramCanvas
        :edges="store.document.edges"
        :nodes="store.document.nodes"
        read-only
        @select-edge="(id) => (selection = { kind: 'edge', id })"
        @select-node="(id) => (selection = { kind: 'node', id })"
        @clear-selection="selection = null"
      />
      <aside class="details" aria-label="Selected node or edge details">
        <p v-if="!selectedNode && !selectedEdge" class="hint">
          Select a node or edge to view its details.
        </p>
        <template v-else-if="selectedNode">
          <p class="text-caption text-uppercase">
            {{
              selectedNode.type === "product"
                ? getProduct(selectedNode.data.productId).category
                : "External actor"
            }}
          </p>
          <h2 class="text-subtitle-1">{{ selectedNode.data.label }}</h2>
          <p v-if="selectedNode.type === 'product'" class="text-body-2">
            {{ selectedNode.data.description }}
          </p>
        </template>
        <template v-else-if="selectedEdge">
          <p class="text-caption text-uppercase">{{ selectedEdge.data.relationship }}</p>
          <p class="text-body-2">{{ selectedEdge.data.label }}</p>
        </template>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-block-size: 100vh;
}
.toolbar {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 1rem 1.5rem;
}
.eyebrow {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 0.25rem;
  text-transform: uppercase;
}
.title {
  font-size: 1.3rem;
  margin: 0;
}
.canvas-wrap {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(20rem, 1fr) 18rem;
}
.details {
  border-inline-start: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 1rem;
}
.hint {
  color: rgb(var(--v-theme-on-surface-variant));
}
@media (max-width: 900px) {
  .canvas-wrap {
    grid-template-columns: 1fr;
  }
}
</style>
