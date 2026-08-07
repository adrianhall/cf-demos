<script setup lang="ts">
import { computed, ref } from "vue";
import { catalog } from "../../../graph/catalog";
import { useDiagramDocumentStore } from "../../stores/diagram-document";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";

/** Searchable Cloudflare product palette plus an external-actor add button. */
const store = useDiagramDocumentStore();
const search = ref("");

const filteredCatalog = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) {
    return catalog;
  }
  return catalog.filter(
    (product) =>
      product.label.toLowerCase().includes(query) ||
      product.category.toLowerCase().includes(query) ||
      product.description.toLowerCase().includes(query),
  );
});

/** Stagger new nodes so repeated adds do not stack exactly on top of each other. */
function nextPosition(): { x: number; y: number } {
  const count = store.document?.nodes.length ?? 0;
  const column = count % 4;
  const row = Math.floor(count / 4);
  return { x: 120 + column * 220, y: 100 + row * 140 };
}

/** Add a product node from the palette at a deterministic staggered position. */
async function addProduct(
  productId: (typeof catalog)[number]["id"],
): Promise<void> {
  const product = catalog.find((candidate) => candidate.id === productId);
  if (!product) {
    return;
  }
  await store.addNode({
    id: `${productId}-${crypto.randomUUID()}`,
    type: "product",
    position: nextPosition(),
    data: { productId, label: product.label, description: product.description },
  });
}

/** Add a new external-actor node. */
async function addActor(): Promise<void> {
  await store.addNode({
    id: `actor-${crypto.randomUUID()}`,
    type: "actor",
    position: nextPosition(),
    data: { kind: "external-actor", label: "External actor" },
  });
}
</script>

<template>
  <aside aria-label="Cloudflare product palette" class="palette">
    <v-text-field
      v-model="search"
      clearable
      density="compact"
      hide-details
      label="Search products"
      variant="outlined"
    >
      <template #prepend-inner>
        <FeatherIcon name="search" />
      </template>
    </v-text-field>

    <v-list aria-label="Curated Cloudflare products" density="compact">
      <v-list-item
        v-for="product in filteredCatalog"
        :key="product.id"
        :disabled="store.pending"
        :subtitle="product.description"
        @click="addProduct(product.id)"
      >
        <template #prepend>
          <FeatherIcon name="plus" />
        </template>
        <template #title>
          <span class="palette-category">{{ product.category }}</span>
          <strong class="d-block">{{ product.label }}</strong>
        </template>
      </v-list-item>
      <v-list-item v-if="filteredCatalog.length === 0" disabled title="No matching products" />
    </v-list>

    <v-btn block :disabled="store.pending" variant="outlined" @click="addActor">
      <template #prepend>
        <FeatherIcon name="user" />
      </template>
      Add external actor
    </v-btn>
  </aside>
</template>

<style scoped>
.palette {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}
.palette-category {
  color: rgb(var(--v-theme-primary));
  display: block;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
}
</style>
