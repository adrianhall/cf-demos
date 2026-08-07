<script setup lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { Handle, Position } from "@vue-flow/core";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { getProduct } from "../../../graph/catalog";
import type { ProductNodeData } from "../../../graph/types";

/** Vue Flow supplies this node's persisted data as its `data` prop. */
defineProps<{ data: ProductNodeData }>();
</script>

<template>
  <Handle :position="Position.Left" type="target" />
  <article class="product-node">
    <span class="product-category">{{ getProduct(data.productId).category }}</span>
    <strong>{{ data.label }}</strong>
    <span>{{ data.description }}</span>
  </article>
  <Handle :position="Position.Right" type="source" />
</template>

<style scoped>
.product-node {
  background: white;
  border: 2px solid rgb(var(--v-theme-primary));
  border-radius: 0.6rem;
  display: grid;
  gap: 0.2rem;
  min-width: 10rem;
  padding: 0.65rem;
}
.product-category {
  color: rgb(var(--v-theme-primary));
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
}
</style>
