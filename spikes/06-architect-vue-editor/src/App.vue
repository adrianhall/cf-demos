<script setup lang="ts">
import { computed, shallowRef } from "vue";
import DiagramCanvas from "./components/DiagramCanvas.vue";
import DiagramPalette from "./components/DiagramPalette.vue";
import PropertiesPanel from "./components/PropertiesPanel.vue";
import { createProductNode, initialGraph, cloneGraph, restoreGraph, saveGraph } from "./graph/store";
import { layoutGraph } from "./graph/layout";
import type { ArchitectureNode, GraphDocument, GraphPoint, ProductId } from "./graph/types";

/** The editor container owns graph state, persistence, and all mutation guards. */
const graph = shallowRef<GraphDocument>(cloneGraph(initialGraph));
/** Prevent all graph mutations while retaining inspect, pan, and zoom behavior. */
const readOnly = shallowRef(false);
/** The selected node is derived from its stable graph id. */
const selectedNodeId = shallowRef<string>();
/** This graph-space coordinate intentionally stays constant across browser viewports. */
const remoteCursor: GraphPoint = { x: 420, y: 250 };
const selectedNode = computed(() => graph.value.nodes.find((node) => node.id === selectedNodeId.value));

/** Add a product from the palette at a deterministic fallback location. */
function addProduct(productId: ProductId): void {
  if (readOnly.value) return;
  graph.value = { ...graph.value, nodes: [...graph.value.nodes, createProductNode(productId, { x: 200, y: 380 })] };
}

/** Add a dropped product at the flow coordinate supplied by Vue Flow. */
function dropProduct(productId: string, position: GraphPoint): void {
  if (readOnly.value || !isProductId(productId)) return;
  graph.value = { ...graph.value, nodes: [...graph.value.nodes, createProductNode(productId, position)] };
}

/** Replace canvas nodes only from a writable interaction. */
function updateNodes(nodes: ArchitectureNode[]): void {
  if (!readOnly.value) graph.value = { ...graph.value, nodes };
}

/** Replace canvas edges only from a writable interaction. */
function updateEdges(edges: GraphDocument["edges"]): void {
  if (!readOnly.value) graph.value = { ...graph.value, edges };
}

/** Replace a properties-panel node by identifier. */
function updateNode(node: ArchitectureNode): void {
  if (!readOnly.value) graph.value = { ...graph.value, nodes: graph.value.nodes.map((current) => current.id === node.id ? node : current) };
}

/** Persist the whole versioned graph contract to local storage. */
function save(): void { saveGraph(graph.value); }

/** Restore a previously saved graph document if local storage contains one. */
function restore(): void {
  const restored = restoreGraph();
  if (restored) { graph.value = restored; selectedNodeId.value = undefined; }
}

/** Run ELK on a copy of the saved graph and retain edge metadata unchanged. */
async function autoLayout(): Promise<void> {
  if (!readOnly.value) graph.value = await layoutGraph(graph.value);
}

/** Narrow an untrusted drag string to one of the five curated identifiers. */
function isProductId(value: string): value is ProductId {
  return ["workers", "d1", "r2", "kv", "workflows"].includes(value);
}
</script>

<template>
  <v-app>
    <v-main class="app-shell">
      <header class="toolbar">
        <div><h1>Cooperative Architect</h1><p>Local Vue Flow editor spike</p></div>
        <v-spacer />
        <v-btn :variant="readOnly ? 'flat' : 'outlined'" :color="readOnly ? 'warning' : undefined" @click="readOnly = !readOnly">{{ readOnly ? 'Read-only mode' : 'Editing mode' }}</v-btn>
        <v-btn :disabled="readOnly" variant="outlined" @click="autoLayout">Auto layout</v-btn>
        <v-btn :disabled="readOnly" variant="outlined" @click="restore">Restore JSON</v-btn>
        <v-btn :disabled="readOnly" color="primary" @click="save">Save JSON</v-btn>
      </header>
      <section class="editor" :class="{ 'editor--readonly': readOnly }">
        <DiagramPalette @drop-product="addProduct" />
        <DiagramCanvas :nodes="graph.nodes" :edges="graph.edges" :viewport="graph.viewport" :read-only="readOnly" :remote-cursor="remoteCursor"
          @update-nodes="updateNodes" @update-edges="updateEdges" @select-node="selectedNodeId = $event" @drop-at="dropProduct"
          @update-viewport="graph = { ...graph, viewport: $event }" />
        <PropertiesPanel :node="selectedNode" :read-only="readOnly" @update-node="updateNode" />
      </section>
    </v-main>
  </v-app>
</template>

<style scoped>
.app-shell { min-height: 100vh; }
.toolbar { align-items: center; border-bottom: 1px solid #d9e2ef; display: flex; gap: .75rem; padding: .75rem 1rem; }
h1 { font-size: 1.2rem; margin: 0; } p { color: #52657d; font-size: .85rem; margin: .2rem 0 0; }
.editor { display: grid; grid-template-columns: 14rem minmax(20rem, 1fr) 16rem; min-height: calc(100vh - 5.25rem); }
.editor--readonly { background: #fffdf7; }
@media (max-width: 800px) { .toolbar { align-items: flex-start; flex-wrap: wrap; } .editor { grid-template-columns: 1fr; } }
</style>
