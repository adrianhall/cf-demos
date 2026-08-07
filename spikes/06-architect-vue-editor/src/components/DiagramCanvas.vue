<script setup lang="ts">
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { VueFlow, type ViewportTransform, useVueFlow } from "@vue-flow/core";
import { computed } from "vue";
import { graphToScreen } from "../graph/coordinates";
import type { ArchitectureEdge, ArchitectureNode, GraphPoint } from "../graph/types";
import ActorNode from "./ActorNode.vue";
import ProductNode from "./ProductNode.vue";
import TypedEdge from "./TypedEdge.vue";

/** Keep the Vue Flow interaction surface separate from editor persistence and selection state. */
const props = defineProps<{ nodes: ArchitectureNode[]; edges: ArchitectureEdge[]; viewport: ViewportTransform; readOnly: boolean; remoteCursor: GraphPoint }>();
/** Report accepted canvas changes to the editor container. */
const emit = defineEmits<{
  updateNodes: [nodes: ArchitectureNode[]];
  updateEdges: [edges: ArchitectureEdge[]];
  selectNode: [nodeId: string];
  dropAt: [productId: string, position: GraphPoint];
  updateViewport: [viewport: ViewportTransform];
}>();
const { project } = useVueFlow();

/** Reject all canvas-generated graph mutations when the viewer is read-only. */
const canvasNodes = computed({ get: () => props.nodes, set: (nodes: ArchitectureNode[]) => { if (!props.readOnly) emit("updateNodes", nodes); } });
/** Reject all canvas-generated edge mutations when the viewer is read-only. */
const canvasEdges = computed({ get: () => props.edges, set: (edges: ArchitectureEdge[]) => { if (!props.readOnly) emit("updateEdges", edges); } });

/** Translate the native palette payload at the canvas boundary using Vue Flow's viewport-aware API. */
function drop(event: DragEvent): void {
  event.preventDefault();
  if (props.readOnly) return;
  const productId = event.dataTransfer?.getData("application/x-architect-product");
  if (productId) emit("dropAt", productId, project({ x: event.clientX, y: event.clientY }));
}

/** Position a remote graph-space cursor in this viewer's current pan/zoom viewport. */
const remoteScreen = computed(() => graphToScreen(props.remoteCursor, props.viewport));
</script>

<template>
  <main class="canvas" @dragover.prevent @drop="drop">
    <VueFlow v-model:nodes="canvasNodes" v-model:edges="canvasEdges" :default-viewport="props.viewport" :nodes-draggable="!props.readOnly"
      :nodes-connectable="!props.readOnly" :elements-selectable="!props.readOnly" :node-types="{ product: ProductNode, actor: ActorNode }"
      :edge-types="{ request: TypedEdge, event: TypedEdge }" :pan-on-drag="true" :zoom-on-scroll="true"
      @node-click="(_, node) => emit('selectNode', node.id)" @move-end="(_, viewport) => emit('updateViewport', viewport)">
      <Background pattern-color="#cad8ea" />
      <Controls />
      <div class="remote-cursor" :style="{ transform: `translate(${remoteScreen.x}px, ${remoteScreen.y}px)` }" aria-label="Remote cursor at graph coordinate 420, 250">Remote editor</div>
    </VueFlow>
  </main>
</template>

<style scoped>
.canvas { min-height: 36rem; position: relative; }
.remote-cursor { background: #6e358d; border-radius: .25rem; color: white; font-size: .7rem; padding: .2rem .35rem; pointer-events: none; position: absolute; z-index: 5; }
</style>
