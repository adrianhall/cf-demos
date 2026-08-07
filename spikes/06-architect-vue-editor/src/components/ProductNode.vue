<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { getProduct } from "../graph/catalog";
import type { ProductNodeData } from "../graph/types";

/** Vue Flow supplies typed product metadata to this renderer. */
const props = defineProps<{ data: ProductNodeData }>();
</script>

<template>
  <Handle type="target" :position="Position.Left" />
  <article class="product-node">
    <span class="product-category">{{ getProduct(props.data.productId).category }}</span>
    <strong>{{ props.data.label }}</strong>
    <span>{{ props.data.description }}</span>
  </article>
  <Handle type="source" :position="Position.Right" />
</template>

<style scoped>
.product-node { background: #fff; border: 2px solid #3a78c2; border-radius: .6rem; display: grid; gap: .2rem; min-width: 10rem; padding: .65rem; }
.product-category { color: #315f9f; font-size: .7rem; font-weight: 700; text-transform: uppercase; }
</style>
