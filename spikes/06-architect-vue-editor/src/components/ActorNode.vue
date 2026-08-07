<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import type { ActorNodeData } from "../graph/types";

/** Vue Flow supplies external-actor metadata to this renderer. */
const props = defineProps<{ data: ActorNodeData }>();
</script>

<template>
  <Handle type="target" :position="Position.Left" />
  <article class="actor-node">{{ props.data.label }}</article>
  <Handle type="source" :position="Position.Right" />
</template>

<style scoped>
.actor-node { background: #fff6dd; border: 2px dashed #a36900; border-radius: 999px; min-width: 8rem; padding: .65rem; text-align: center; }
</style>
