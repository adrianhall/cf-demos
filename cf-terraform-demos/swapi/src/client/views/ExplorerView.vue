<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CollectionColumn from '../components/CollectionColumn.vue';
import EntityDetail from '../components/EntityDetail.vue';
import TypeNavigation from '../components/TypeNavigation.vue';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import { explorerLocation, routeState } from '../router';
import { useCatalogStore, type EntitySummary } from '../stores/catalog';
import { useExplorerStore } from '../stores/explorer';

const route = useRoute();
const router = useRouter();
const catalog = useCatalogStore();
const explorer = useExplorerStore();
const state = computed(() => routeState(route));

watch(
  state,
  (next) => {
    if (next.typeId === null) {
      explorer.restoreTrail([]);
      return;
    }

    // A URL restored from `trail` already holds the originating collection (and any intermediate
    // entities). A fresh `/people/<id>` has no trail, so seed it with the collection the pathname
    // names. Avoid adding it a second time in the former case: a breadcrumb must describe the path
    // actually taken, not repeat the first step because it happened to match the terminal type.
    const steps =
      next.trail.length > 0
        ? [...next.trail]
        : [{ typeId: next.typeId, entityId: null, label: ENTITY_TYPES[next.typeId].label }];
    if (next.entityId !== null) {
      steps.push({ typeId: next.typeId, entityId: next.entityId, label: 'Loading…' });
    }
    explorer.restoreTrail(steps);
  },
  { immediate: true }
);

// Deep links preserve entity identifiers in the URL but cannot preserve their display names
// without duplicating them as untrusted query text. Load each entity in a restored path and replace
// its placeholder from the authoritative record. The catalog cache makes this free for records the
// user has already visited, and the loop is deliberately sequential only in the sense that no step
// depends on another — every fetch starts together, so a long breadcrumb does not make reload slow.
watch(
  () => explorer.trail,
  (steps) => {
    void Promise.all(
      steps
        .filter((step): step is typeof step & { entityId: string } => step.entityId !== null)
        .map(async (step) => {
          await catalog.loadEntity(step.typeId, step.entityId);
          const record = catalog.entityState(step.typeId, step.entityId).value;
          if (record !== null) {
            explorer.labelStep(
              step.typeId,
              step.entityId,
              String(record[ENTITY_TYPES[step.typeId].displayField] ?? 'Unnamed record')
            );
          }
        })
    );
  },
  { immediate: true }
);

async function selectCollection(typeId: EntityTypeId): Promise<void> {
  explorer.selectCollection(typeId, ENTITY_TYPES[typeId].label);
  await router.push(explorerLocation(typeId, null, explorer.trail));
}

async function selectEntity(typeId: EntityTypeId, item: EntitySummary): Promise<void> {
  explorer.selectEntity(typeId, item.id, item.title);
  await router.push(explorerLocation(typeId, item.id, explorer.trail));
  await nextTick();
  document.querySelector<HTMLElement>('.detail-header h1')?.focus();
}

async function truncate(index: number): Promise<void> {
  explorer.truncateTo(index);
  const current = explorer.currentStep;
  await router.push(
    explorerLocation(current?.typeId ?? null, current?.entityId ?? null, explorer.trail)
  );
}
</script>

<template>
  <div class="explorer-grid">
    <aside class="navigation-pane">
      <TypeNavigation
        :selected="state.typeId"
        @select="(typeId) => void selectCollection(typeId)"
      />
    </aside>
    <aside class="collection-pane">
      <CollectionColumn
        :selected-id="state.entityId"
        :type-id="state.typeId"
        @select="
          (id, label) =>
            state.typeId && void selectEntity(state.typeId, { id, title: label, subtitle: '' })
        "
      />
    </aside>
    <main class="detail-pane">
      <EntityDetail
        :entity-id="state.entityId"
        :trail="explorer.trail"
        :type-id="state.typeId"
        @select="(typeId, item) => void selectEntity(typeId, item)"
        @truncate="(index) => void truncate(index)"
      />
    </main>
  </div>
</template>

<style scoped>
.explorer-grid {
  block-size: 100%;
  display: grid;
  grid-template-columns: 12rem minmax(16rem, 22rem) minmax(0, 1fr);
  min-block-size: 0;
}
.navigation-pane,
.collection-pane {
  border-inline-end: 1px solid rgb(var(--v-theme-outline-variant));
  min-block-size: 0;
}
.detail-pane {
  min-block-size: 0;
}
@media (max-width: 900px) {
  .explorer-grid {
    grid-template-columns: 4.25rem minmax(15rem, 20rem) minmax(0, 1fr);
  }
}
@media (max-width: 680px) {
  .explorer-grid {
    display: block;
    overflow-y: auto;
  }
  .navigation-pane {
    border-block-end: 1px solid rgb(var(--v-theme-outline-variant));
    border-inline-end: 0;
  }
  .navigation-pane :deep(.navigation) {
    block-size: auto;
  }
  .collection-pane {
    block-size: 18rem;
    border-block-end: 1px solid rgb(var(--v-theme-outline-variant));
    border-inline-end: 0;
  }
  .detail-pane {
    min-block-size: 30rem;
  }
}
</style>
