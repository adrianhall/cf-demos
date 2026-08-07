<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { BaseEdge, EdgeLabelRenderer } from "@vue-flow/core";
import { getBezierPath, type Position } from "@vue-flow/core";
import { computed } from "vue";
import type { ArchitectureEdgeData } from "../../../graph/types";

/** Geometry and semantic metadata Vue Flow provides to this custom edge renderer. */
const props = defineProps<{
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data: ArchitectureEdgeData;
}>();

/** Derive SVG geometry and an accessible label anchor from the current endpoints. */
const path = computed(() => getBezierPath(props));
</script>

<template>
  <BaseEdge
    :id="props.id"
    :path="path[0]"
    :style="{
      stroke: props.data.relationship === 'event' ? '#7b3fa1' : '#16734d',
      strokeDasharray: props.data.relationship === 'event' ? '7 4' : undefined,
      strokeWidth: 2,
    }"
  />
  <EdgeLabelRenderer>
    <span
      class="edge-label"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
    >
      {{ props.data.label }}
    </span>
  </EdgeLabelRenderer>
</template>

<style scoped>
.edge-label {
  background: white;
  border: 1px solid #c6d2e0;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  padding: 0.15rem 0.35rem;
  pointer-events: all;
  position: absolute;
}
</style>
