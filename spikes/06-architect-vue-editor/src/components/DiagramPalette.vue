<script setup lang="ts">
import { catalog } from "../graph/catalog";
import type { ProductId } from "../graph/types";

/** Place a catalog product on the canvas. */
const emit = defineEmits<{ dropProduct: [productId: ProductId] }>();

/** Put only the stable product identifier into the native drag payload. */
function beginDrag(event: DragEvent, productId: ProductId): void {
  event.dataTransfer?.setData("application/x-architect-product", productId);
  event.dataTransfer?.setData("text/plain", productId);
  event.dataTransfer!.effectAllowed = "move";
}
</script>

<template>
  <aside class="palette" aria-label="Cloudflare product palette">
    <h2 class="palette-title">Catalog</h2>
    <p class="palette-hint">Drag products onto the canvas.</p>
    <button v-for="product in catalog" :key="product.id" class="palette-product" draggable="true" type="button"
      @click="emit('dropProduct', product.id)" @dragstart="beginDrag($event, product.id)">
      <span class="palette-category">{{ product.category }}</span>
      <strong>{{ product.label }}</strong>
      <span>{{ product.description }}</span>
    </button>
  </aside>
</template>

<style scoped>
.palette { background: #f7f9fc; border-right: 1px solid #d9e2ef; padding: 1rem; width: 14rem; }
.palette-title { font-size: 1rem; margin: 0; }
.palette-hint { color: #52657d; font-size: .875rem; }
.palette-product { background: white; border: 1px solid #b8c9df; border-radius: .5rem; cursor: grab; display: grid; gap: .2rem; margin: .5rem 0; padding: .65rem; text-align: left; width: 100%; }
.palette-category { color: #315f9f; font-size: .7rem; font-weight: 700; text-transform: uppercase; }
</style>
