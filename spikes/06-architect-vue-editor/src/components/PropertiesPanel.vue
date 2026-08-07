<script setup lang="ts">
import type { ArchitectureNode } from "../graph/types";

/** Display and update one selected node without mutating the parent graph directly. */
const props = defineProps<{ node: ArchitectureNode | undefined; readOnly: boolean }>();
/** Send an immutable node replacement to the editor container. */
const emit = defineEmits<{ updateNode: [node: ArchitectureNode] }>();

/** Update a product label through the explicit parent-owned mutation path. */
function updateLabel(label: string): void {
  if (!props.node || props.readOnly) return;
  emit("updateNode", { ...props.node, data: { ...props.node.data, label } } as ArchitectureNode);
}

/** Update a product description through the explicit parent-owned mutation path. */
function updateDescription(description: string): void {
  if (!props.node || props.readOnly || !("productId" in props.node.data)) return;
  emit("updateNode", { ...props.node, data: { ...props.node.data, description } });
}
</script>

<template>
  <aside class="properties" aria-label="Selected node properties">
    <h2 class="properties-title">Properties</h2>
    <p v-if="!props.node">Select a node to edit its properties.</p>
    <template v-else>
      <label class="field">Label
        <input :disabled="props.readOnly" :value="props.node.data.label" @input="updateLabel(($event.target as HTMLInputElement).value)" />
      </label>
      <label v-if="'productId' in props.node.data" class="field">Description
        <textarea :disabled="props.readOnly" :value="props.node.data.description" @input="updateDescription(($event.target as HTMLTextAreaElement).value)" />
      </label>
      <p v-if="props.readOnly" class="readonly-note">Read-only: pan, zoom, and inspect only.</p>
    </template>
  </aside>
</template>

<style scoped>
.properties { border-left: 1px solid #d9e2ef; padding: 1rem; width: 16rem; }
.properties-title { font-size: 1rem; margin: 0; }
.field { display: grid; font-size: .85rem; font-weight: 700; gap: .3rem; margin-top: .75rem; }
input, textarea { border: 1px solid #9fb3ca; border-radius: .35rem; padding: .45rem; }
.readonly-note { color: #6c4a00; font-size: .85rem; }
</style>
