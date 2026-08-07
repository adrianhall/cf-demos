<script setup lang="ts">
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@vue-flow/core";
import type { ArchitectureEdgeData } from "../graph/types";

/** Receive the geometry and semantic metadata Vue Flow provides to a custom edge. */
const props = defineProps<{
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: import("@vue-flow/core").Position;
  targetPosition: import("@vue-flow/core").Position;
  data: ArchitectureEdgeData;
}>();

/** Derive SVG geometry and an accessible label anchor from current endpoints. */
const path = getBezierPath(props);
</script>

<template>
  <BaseEdge :id="props.id" :path="path[0]" :style="{ stroke: props.data.relationship === 'event' ? '#7b3fa1' : '#16734d', strokeDasharray: props.data.relationship === 'event' ? '7 4' : undefined, strokeWidth: 2 }" />
  <EdgeLabelRenderer>
    <span class="edge-label" :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }">{{ props.data.label }}</span>
  </EdgeLabelRenderer>
</template>

<style scoped>
.edge-label { background: white; border: 1px solid #c6d2e0; border-radius: .25rem; font-size: .75rem; padding: .15rem .35rem; pointer-events: all; position: absolute; }
</style>
