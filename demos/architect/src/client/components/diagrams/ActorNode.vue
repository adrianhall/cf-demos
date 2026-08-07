<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { Handle, Position } from "@vue-flow/core";
import type { ActorNodeData } from "../../../graph/types";

/** Vue Flow supplies this node's persisted data as its `data` prop. */
defineProps<{ data: ActorNodeData }>();
</script>

<template>
  <Handle :position="Position.Left" type="target" />
  <article class="actor-node">{{ data.label }}</article>
  <Handle :position="Position.Right" type="source" />
</template>

<style scoped>
.actor-node {
  background: rgb(var(--v-theme-surface-variant));
  border: 2px dashed rgb(var(--v-theme-secondary));
  border-radius: 999px;
  min-width: 8rem;
  padding: 0.65rem;
  text-align: center;
}
</style>
