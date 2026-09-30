<script setup lang="ts">
import { computed, nextTick, onMounted, useTemplateRef, watch } from 'vue';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import { useCatalogStore } from '../stores/catalog';
import { useExplorerStore } from '../stores/explorer';

const props = defineProps<{ typeId: EntityTypeId | null; selectedId: string | null }>();
const emit = defineEmits<{ select: [id: string, label: string] }>();
const catalog = useCatalogStore();
const explorer = useExplorerStore();
const list = useTemplateRef<HTMLElement>('list');

const descriptor = computed(() => (props.typeId === null ? null : ENTITY_TYPES[props.typeId]));
const state = computed(() =>
  props.typeId === null ? null : catalog.collectionState(props.typeId)
);
const filter = computed({
  get: () => (props.typeId === null ? '' : explorer.filterFor(props.typeId)),
  set: (value: string) => {
    if (props.typeId !== null) explorer.setFilter(props.typeId, value);
  }
});
const visibleItems = computed(() => {
  const items = state.value?.value ?? [];
  const term = filter.value.trim().toLocaleLowerCase();
  return term.length === 0
    ? items
    : items.filter((item) => item.title.toLocaleLowerCase().includes(term));
});
const resultLabel = computed(
  () => `${visibleItems.value.length} of ${state.value?.value?.length ?? 0}`
);

async function load(): Promise<void> {
  if (props.typeId !== null) await catalog.loadCollection(props.typeId);
}

/**
 * Bring the selected record into the independently scrolling collection list.
 *
 * Relation navigation replaces both the selected type and selected entity at once. The list often
 * has not mounted yet when those props change, and even when it has, its rows may still be loading.
 * Waiting for Vue's next render and watching the visible row identifiers covers both cases without
 * a timeout. `block: 'nearest'` is important: an already-visible row stays where it is, while an
 * off-screen row moves only as far as needed rather than jumping to the top every time.
 *
 * Focus stays in the detail heading, as UISPEC §14 requires after detail replacement. Scrolling is
 * visual context, not focus movement, so keyboard and screen-reader users are not unexpectedly
 * pulled back into the collection column.
 *
 * @returns A promise fulfilled after the render has settled and any required scroll has happened.
 */
async function scrollSelectionIntoView(): Promise<void> {
  if (props.selectedId === null) {
    return;
  }

  await nextTick();
  const selected = list.value?.querySelector<HTMLElement>(
    `[data-entity-id="${CSS.escape(props.selectedId)}"]`
  );
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

onMounted(() => void load());
watch(
  () => props.typeId,
  () => void load()
);
watch(
  [
    () => props.selectedId,
    // A selected ID may arrive before its new collection does. Watching the rendered row keys
    // retries after that collection finishes loading, without making store internals part of this
    // component's scrolling contract.
    () => visibleItems.value.map((item) => item.id).join(',')
  ],
  () => void scrollSelectionIntoView(),
  { immediate: true }
);
</script>

<template>
  <section aria-label="Collection" class="collection">
    <template v-if="descriptor && state">
      <header class="collection-header">
        <h2 class="collection-title">{{ descriptor.label }}</h2>
        <span class="result-count">{{ resultLabel }}</span>
      </header>
      <v-text-field
        v-model="filter"
        aria-label="Filter this collection"
        class="collection-filter"
        clearable
        density="compact"
        hide-details
        placeholder="Filter this list"
        prepend-inner-icon="mdi-filter-variant"
        variant="outlined"
      />
      <v-progress-linear v-if="state.loading" class="loading" indeterminate />
      <v-alert v-else-if="state.error" density="compact" type="error">
        {{ state.error }} <v-btn size="small" variant="text" @click="void load">Retry</v-btn>
      </v-alert>
      <div v-else-if="visibleItems.length === 0" class="empty-list">
        <template v-if="filter.trim()"
          >No {{ descriptor.label.toLocaleLowerCase() }} match “{{ filter }}”.
          <v-btn size="small" variant="text" @click="filter = ''">Clear filter</v-btn></template
        >
        <template v-else>No {{ descriptor.label.toLocaleLowerCase() }} are available.</template>
      </div>
      <div v-else ref="list" class="entity-list-scroll">
        <v-list class="entity-list" nav>
          <v-list-item
            v-for="item in visibleItems"
            :key="item.id"
            :active="item.id === props.selectedId"
            :data-entity-id="item.id"
            :subtitle="item.subtitle"
            :title="item.title"
            @click="emit('select', item.id, item.title)"
          />
        </v-list>
      </div>
    </template>
    <div v-else class="empty-list">Choose a collection to browse its records.</div>
  </section>
</template>

<style scoped>
.collection {
  block-size: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-block-size: 0;
  /* The record list owns scrolling, so the column itself must not also scroll. */
  overflow: hidden;
  padding: 1rem;
}
.collection-header {
  align-items: baseline;
  display: flex;
  flex: 0 0 auto;
  gap: 0.5rem;
}
.collection-filter {
  /*
   * This column is a flex container, so without an explicit basis the filter is a stretchable
   * child and grows to share the leftover height with the list. It must stay exactly one input
   * tall: the list is the part that should absorb free space, not the control that narrows it.
   */
  flex: 0 0 auto;
}
.collection-title {
  font-size: 1.125rem;
  margin: 0;
}
.result-count {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
}
.loading {
  flex: 0 0 auto;
}
.entity-list-scroll {
  /* The records are what should consume the column's remaining height and scroll within it. */
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
}
.entity-list {
  padding: 0;
}
.empty-list {
  color: rgb(var(--v-theme-on-surface-variant));
  padding: 2rem 0.5rem;
}
</style>
