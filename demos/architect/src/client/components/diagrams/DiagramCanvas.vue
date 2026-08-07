<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { Background } from "@vue-flow/background";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { Controls } from "@vue-flow/controls";
import type {
  Connection,
  EdgeMouseEvent,
  NodeDragEvent,
  NodeMouseEvent,
} from "@vue-flow/core";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { VueFlow } from "@vue-flow/core";
import { ref, watch } from "vue";
import type { ArchitectureEdge, ArchitectureNode } from "../../../graph/types";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ActorNode from "./ActorNode.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ProductNode from "./ProductNode.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import TypedEdge from "./TypedEdge.vue";

/**
 * Presentational Vue Flow adapter: renders nodes/edges and translates its interaction events
 * into explicit emits. Owns no revisioned document state itself — the parent view
 * (`../../views/DiagramEditorView.vue`) forwards these emits to `useDiagramDocumentStore`'s
 * operation methods, matching this component's boundary in
 * `spikes/06-architect-vue-editor/REPORT.md`.
 */
const props = withDefaults(
  defineProps<{
    /** Current authoritative nodes from the open diagram's document. */
    nodes: ArchitectureNode[];
    /** Current authoritative edges from the open diagram's document. */
    edges: ArchitectureEdge[];
    /**
     * Disable every mutation gesture (drag, connect) while leaving pan/zoom/fit/selection
     * enabled — the same enforcement Spike 06 measured for a true read-only mode
     * (`spikes/06-architect-vue-editor/REPORT.md`). Phase 2 never sets this; it exists now so
     * Phase 6's anonymous public viewer can reuse this component without restructuring it.
     */
    readOnly?: boolean;
  }>(),
  { readOnly: false },
);

const emit = defineEmits<{
  /** A new edge should be created between two existing nodes. */
  connectNodes: [connection: Connection];
  /** The canvas was clicked with nothing under the pointer; clear the selection. */
  clearSelection: [];
  /** A node's drag gesture completed; persist its final position. */
  moveNode: [nodeId: string, position: { x: number; y: number }];
  /** An edge was clicked; select it. */
  selectEdge: [edgeId: string];
  /** A node was clicked; select it. */
  selectNode: [nodeId: string];
}>();

// Vue Flow mutates its `v-model:nodes`/`v-model:edges` arrays in place while the user drags or
// pans (for smooth interactive feedback). Keep a local copy rather than binding v-model directly
// to `props.nodes`/`props.edges` so those interim, purely visual mutations never touch the
// parent's authoritative document — the document only ever changes after a server-confirmed
// operation response (see `DiagramEditorView.vue`), replacing these local copies via the watcher
// below.
const localNodes = ref<ArchitectureNode[]>(
  props.nodes.map((node) => ({ ...node })),
);
const localEdges = ref<ArchitectureEdge[]>(
  props.edges.map((edge) => ({ ...edge })),
);

watch(
  () => props.nodes,
  (nodes) => {
    localNodes.value = nodes.map((node) => ({ ...node }));
  },
);
watch(
  () => props.edges,
  (edges) => {
    localEdges.value = edges.map((edge) => ({ ...edge }));
  },
);

/** Select the clicked node. */
function handleNodeClick(event: NodeMouseEvent): void {
  emit("selectNode", event.node.id);
}

/** Select the clicked edge. */
function handleEdgeClick(event: EdgeMouseEvent): void {
  emit("selectEdge", event.edge.id);
}

/** Persist only the final position — never intermediate drag frames. */
function handleNodeDragStop(event: NodeDragEvent): void {
  emit("moveNode", event.node.id, {
    x: event.node.position.x,
    y: event.node.position.y,
  });
}
</script>

<template>
  <div aria-label="Architecture diagram canvas" class="canvas" role="application">
    <VueFlow
      v-model:nodes="localNodes"
      v-model:edges="localEdges"
      :edge-types="{ request: TypedEdge, event: TypedEdge }"
      :node-types="{ product: ProductNode, actor: ActorNode }"
      :nodes-connectable="!props.readOnly"
      :nodes-draggable="!props.readOnly"
      fit-view-on-init
      @connect="(connection) => emit('connectNodes', connection)"
      @edge-click="handleEdgeClick"
      @node-click="handleNodeClick"
      @node-drag-stop="handleNodeDragStop"
      @pane-click="emit('clearSelection')"
    >
      <Background pattern-color="#cad8ea" />
      <Controls />
    </VueFlow>
  </div>
</template>

<style scoped>
.canvas {
  block-size: 100%;
  min-block-size: 32rem;
  position: relative;
}
</style>
