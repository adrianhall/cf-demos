<script setup lang="ts">
import { ENTITY_TYPES, ENTITY_TYPE_IDS, type EntityTypeId } from '../domain/entity-types';

const props = defineProps<{ selected: EntityTypeId | null }>();
const emit = defineEmits<{ select: [typeId: EntityTypeId] }>();
</script>

<template>
  <nav aria-label="Collections" class="navigation">
    <h2 class="column-heading">Explore</h2>
    <v-list nav>
      <v-list-item
        v-for="typeId in ENTITY_TYPE_IDS"
        :key="typeId"
        :active="props.selected === typeId"
        :title="ENTITY_TYPES[typeId].label"
        @click="emit('select', typeId)"
      />
    </v-list>
  </nav>
</template>

<style scoped>
.navigation {
  block-size: 100%;
  overflow-y: auto;
  padding: 1rem 0.5rem;
}
.column-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  margin: 0 0.75rem 0.5rem;
  text-transform: uppercase;
}
</style>
