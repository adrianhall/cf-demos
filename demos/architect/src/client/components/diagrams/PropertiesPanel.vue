<script setup lang="ts">
import { computed } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import { getProduct } from "../../../graph/catalog";
import { useDiagramDocumentStore } from "../../stores/diagram-document";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";

/**
 * Displays and edits the selected node or edge.
 *
 * Edge data (`relationship`/`label`) is set only once, at `add_edge` time — Phase 2 defines no
 * `update_edge` operation kind (see `../../../graph/operations.ts`'s documented kind list), so
 * this panel shows an edge's details read-only alongside its Delete action rather than editable
 * fields.
 */
const store = useDiagramDocumentStore();

const isProductNode = computed(() => store.selectedNode?.type === "product");
const isActorNode = computed(() => store.selectedNode?.type === "actor");

/** Update a product node's label through the store's typed action. */
async function updateProductLabel(label: string): Promise<void> {
  const node = store.selectedNode;
  if (node?.type !== "product") {
    return;
  }
  await store.updateNode(node.id, { ...node.data, label });
}

/** Update a product node's description through the store's typed action. */
async function updateProductDescription(description: string): Promise<void> {
  const node = store.selectedNode;
  if (node?.type !== "product") {
    return;
  }
  await store.updateNode(node.id, { ...node.data, description });
}

/** Update an actor node's label through the store's typed action. */
async function updateActorLabel(label: string): Promise<void> {
  const node = store.selectedNode;
  if (node?.type !== "actor") {
    return;
  }
  await store.updateNode(node.id, { ...node.data, label });
}

/** Delete the currently selected node. */
async function deleteSelectedNode(): Promise<void> {
  if (store.selectedNode) {
    await store.deleteNode(store.selectedNode.id);
  }
}

/** Delete the currently selected edge. */
async function deleteSelectedEdge(): Promise<void> {
  if (store.selectedEdge) {
    await store.deleteEdge(store.selectedEdge.id);
  }
}
</script>

<template>
  <aside aria-label="Selected node or edge properties" class="properties">
    <h2 class="text-subtitle-1">Properties</h2>

    <p v-if="!store.selectedNode && !store.selectedEdge" class="text-body-2">
      Select a node or edge to view or edit its properties.
    </p>

    <template v-else-if="store.selectedNode">
      <p class="text-caption text-uppercase">
        {{ isProductNode ? getProduct(store.selectedNode.data.productId).category : "External actor" }}
      </p>

      <v-text-field
        v-if="isProductNode"
        :model-value="store.selectedNode.data.label"
        density="compact"
        label="Label"
        variant="outlined"
        @update:model-value="updateProductLabel"
      />
      <v-textarea
        v-if="isProductNode"
        :model-value="(store.selectedNode.data as { description: string }).description"
        density="compact"
        label="Description"
        rows="3"
        variant="outlined"
        @update:model-value="updateProductDescription"
      />
      <v-text-field
        v-if="isActorNode"
        :model-value="store.selectedNode.data.label"
        density="compact"
        label="Label"
        variant="outlined"
        @update:model-value="updateActorLabel"
      />

      <v-btn color="error" variant="text" @click="deleteSelectedNode">
        <template #prepend><FeatherIcon name="trash-2" /></template>
        Delete node
      </v-btn>
    </template>

    <template v-else-if="store.selectedEdge">
      <p class="text-caption text-uppercase">{{ store.selectedEdge.data.relationship }}</p>
      <p class="text-body-2">{{ store.selectedEdge.data.label }}</p>
      <p class="text-caption">
        {{ store.selectedEdge.source }} <FeatherIcon name="corner-down-right" /> {{ store.selectedEdge.target }}
      </p>

      <v-btn color="error" variant="text" @click="deleteSelectedEdge">
        <template #prepend><FeatherIcon name="trash-2" /></template>
        Delete edge
      </v-btn>
    </template>
  </aside>
</template>

<style scoped>
.properties {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
}
</style>
