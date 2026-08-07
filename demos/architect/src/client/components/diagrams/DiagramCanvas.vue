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
import { useVueFlow, VueFlow } from "@vue-flow/core";
import { computed, ref, watch } from "vue";
import { CURSOR_BROADCAST_INTERVAL_MS } from "../../../collaboration-protocol";
import type {
  CursorSelection,
  Participant,
} from "../../../collaboration-protocol";
import type { ArchitectureEdge, ArchitectureNode } from "../../../graph/types";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ActorNode from "./ActorNode.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import ProductNode from "./ProductNode.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import RemoteCursorMarker from "./RemoteCursorMarker.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import TypedEdge from "./TypedEdge.vue";

/** One remote collaborator's transient cursor/selection, as rendered by this canvas. */
export interface RemoteCursor extends Participant {
  /** Graph-space horizontal position. */
  x: number;
  /** Graph-space vertical position. */
  y: number;
  /** That participant's current selection, or `null`. */
  selection: CursorSelection | null;
}

/**
 * Presentational Vue Flow adapter: renders nodes/edges and translates its interaction events
 * into explicit emits. Owns no revisioned document state itself — the parent view
 * (`../../views/DiagramEditorView.vue`) forwards these emits to `useDiagramDocumentStore`'s
 * operation methods, matching this component's boundary in
 * `spikes/06-architect-vue-editor/REPORT.md`. Phase 4 adds remote cursor rendering and local
 * cursor capture on top of that same boundary — see {@link RemoteCursor} and `cursorMove` below.
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
    /** Every other connected participant's last known cursor/selection, from the live room. */
    remoteCursors?: RemoteCursor[];
  }>(),
  { readOnly: false, remoteCursors: () => [] },
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
  /** The local pointer moved over the canvas, already converted to graph-space coordinates. */
  cursorMove: [x: number, y: number];
}>();

// Called at the top level, sibling to <VueFlow> below, rather than inside a descendant slot —
// this is Vue Flow's own documented pattern for sharing one store instance between a component's
// setup script and the <VueFlow> it renders, with no explicit id needed for a single-editor-per-
// page layout like this one.
const { screenToFlowCoordinate, viewport } = useVueFlow();

/** Honor the platform's reduced-motion preference for the remote cursor markers' movement. */
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let lastCursorEmitAt = 0;

/**
 * Convert one remote participant's graph-space cursor into this viewer's own screen pixels.
 *
 * Applies the exact inverse of Vue Flow's own pane transform
 * (`translate(viewport.x, viewport.y) scale(viewport.zoom)`), so a marker rendered at this
 * position — absolutely positioned within the same untransformed `.canvas` container Vue Flow's
 * pane itself fills — lines up with the actual node/edge it points at regardless of this
 * viewer's own pan/zoom, matching `spikes/06-architect-vue-editor/REPORT.md`'s graph-space
 * cursor protocol decision.
 */
function screenPosition(cursor: { x: number; y: number }): {
  left: number;
  top: number;
} {
  return {
    left: cursor.x * viewport.value.zoom + viewport.value.x,
    top: cursor.y * viewport.value.zoom + viewport.value.y,
  };
}

/**
 * Convert the local pointer's client coordinates to graph space and emit `cursorMove`, rate-
 * limited to the same interval the room enforces server-side
 * (`CURSOR_BROADCAST_INTERVAL_MS`) — sending faster than the room will ever broadcast would only
 * waste socket bandwidth.
 */
function handlePointerMove(event: MouseEvent): void {
  const now = Date.now();
  if (now - lastCursorEmitAt < CURSOR_BROADCAST_INTERVAL_MS) {
    return;
  }
  lastCursorEmitAt = now;
  const flowPosition = screenToFlowCoordinate({
    x: event.clientX,
    y: event.clientY,
  });
  emit("cursorMove", flowPosition.x, flowPosition.y);
}

const remoteCursorMarkers = computed(() =>
  props.remoteCursors.map((cursor) => ({
    ...cursor,
    ...screenPosition(cursor),
  })),
);

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
  <div
    aria-label="Architecture diagram canvas"
    class="canvas"
    role="application"
    @mousemove="handlePointerMove"
  >
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
    <RemoteCursorMarker
      v-for="cursor in remoteCursorMarkers"
      :key="cursor.email"
      :email="cursor.email"
      :left="cursor.left"
      :reduced-motion="prefersReducedMotion"
      :role="cursor.role"
      :top="cursor.top"
    />
  </div>
</template>

<style scoped>
.canvas {
  block-size: 100%;
  min-block-size: 32rem;
  position: relative;
}
</style>
