<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { classifyAttributeValue, isMissing } from '../domain/attribute-value';
import {
  ENTITY_TYPES,
  PROVENANCE_ATTRIBUTES,
  type EntityTypeId,
  type RelationDescriptor
} from '../domain/entity-types';
import { useCatalogStore, type EntityRecord, type EntitySummary } from '../stores/catalog';
import type { TrailStep } from '../stores/explorer';

const props = defineProps<{
  typeId: EntityTypeId | null;
  entityId: string | null;
  trail: readonly TrailStep[];
}>();
const emit = defineEmits<{
  select: [typeId: EntityTypeId, item: EntitySummary];
  truncate: [index: number];
}>();
const catalog = useCatalogStore();
const provenanceOpen = ref(false);

const descriptor = computed(() => (props.typeId === null ? null : ENTITY_TYPES[props.typeId]));
const state = computed(() =>
  props.typeId === null || props.entityId === null
    ? null
    : catalog.entityState(props.typeId, props.entityId)
);
const entity = computed(() => state.value?.value ?? null);

/**
 * Relation panels whose children are known, counting in O(1) from the record returned with the
 * detail query. Keeping that derivation computed rather than calling `relationItems()` throughout
 * the template means each relation is decoded once per entity change instead of once per rendered
 * binding (title, count, condition, and list).
 */
const relations = computed(() =>
  descriptor.value === null
    ? []
    : descriptor.value.relations.map((relation) => ({ relation, items: relationItems(relation) }))
);
const heading = computed(() => {
  if (descriptor.value === null || entity.value === null) return '';
  return String(entity.value[descriptor.value.displayField] ?? 'Unnamed record');
});
const visibleTrail = computed(() => props.trail);

async function load(): Promise<void> {
  if (props.typeId !== null && props.entityId !== null)
    await catalog.loadEntity(props.typeId, props.entityId);
}

function relationItems(relation: RelationDescriptor): EntitySummary[] {
  if (entity.value === null) return [];
  const raw = entity.value[relation.field];
  const records = relation.single
    ? raw === null || raw === undefined
      ? []
      : [raw]
    : Array.isArray(raw)
      ? raw
      : [];
  return records.filter(isRecord).map((record) => {
    const target = ENTITY_TYPES[relation.target];
    return {
      id: String(record.id),
      title: String(record[target.displayField] ?? ''),
      subtitle: String(record[target.subtitleField] ?? '')
    };
  });
}

function isRecord(value: unknown): value is EntityRecord {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).id === 'string'
  );
}

function provenanceValue(field: string): string {
  return String(entity.value?.[field] ?? '');
}

onMounted(() => void load());
watch(
  () => [props.typeId, props.entityId],
  () => void load()
);
</script>

<template>
  <section aria-live="polite" aria-label="Record detail" class="detail">
    <div v-if="descriptor === null" class="welcome">
      <p class="eyebrow">The Star Wars dataset</p>
      <h1>Follow the connections.</h1>
      <p>
        Choose one of six collections, then follow people, worlds, species, ships, and films
        wherever they lead.
      </p>
      <v-btn href="/graphql" variant="outlined">Open GraphiQL</v-btn>
    </div>
    <div v-else-if="entityId === null" class="welcome">
      <p class="eyebrow">{{ descriptor.label }}</p>
      <h1>Choose a {{ descriptor.singular.toLocaleLowerCase() }}.</h1>
      <p>
        The collection is ready beside this panel. Select a record to see its details and
        connections.
      </p>
    </div>
    <template v-else-if="state">
      <v-progress-linear v-if="state.loading" indeterminate />
      <v-alert v-else-if="state.error && entity === null" density="comfortable" type="error">
        {{ state.error }}
        <v-btn
          v-if="state.error !== 'That record no longer exists.'"
          size="small"
          variant="text"
          @click="void load"
          >Retry</v-btn
        >
      </v-alert>
      <template v-else-if="entity">
        <nav v-if="visibleTrail.length > 0" aria-label="Exploration path" class="breadcrumb">
          <template
            v-for="(step, index) in visibleTrail"
            :key="`${step.typeId}:${step.entityId ?? 'collection'}`"
          >
            <span v-if="index > 0" aria-hidden="true" class="separator">›</span>
            <v-btn
              :aria-current="index === visibleTrail.length - 1 ? 'page' : undefined"
              size="small"
              variant="text"
              @click="emit('truncate', index)"
              >{{ step.label }}</v-btn
            >
          </template>
        </nav>
        <header class="detail-header">
          <p class="eyebrow">{{ descriptor.singular }}</p>
          <h1 tabindex="-1">{{ heading }}</h1>
          <p v-if="typeId === 'films'" class="episode">Episode {{ entity.episodeId }}</p>
        </header>
        <section
          v-for="group in descriptor.attributeGroups"
          :key="group.title ?? 'overview'"
          class="attribute-group"
        >
          <h2 v-if="group.title" class="section-heading">{{ group.title }}</h2>
          <dl class="attributes">
            <template v-for="attribute in group.attributes" :key="attribute.field">
              <dt>{{ attribute.label }}</dt>
              <dd
                :class="{
                  missing: isMissing(classifyAttributeValue(String(entity[attribute.field] ?? ''))),
                  long: attribute.longForm
                }"
              >
                {{ classifyAttributeValue(String(entity[attribute.field] ?? '')).text }}
              </dd>
            </template>
          </dl>
        </section>
        <v-expansion-panels class="relations" multiple>
          <v-expansion-panel v-for="entry in relations" :key="entry.relation.field">
            <v-expansion-panel-title
              >{{ entry.relation.label }}
              <span class="relation-count">{{ entry.items.length }}</span></v-expansion-panel-title
            >
            <v-expansion-panel-text>
              <template v-if="entry.items.length">
                <v-list density="compact">
                  <v-list-item
                    v-for="item in entry.items"
                    :key="item.id"
                    :subtitle="item.subtitle"
                    :title="item.title"
                    @click="emit('select', entry.relation.target, item)"
                  />
                </v-list>
              </template>
              <p v-else class="empty-relation">{{ entry.relation.emptyLabel }}</p>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
        <v-expansion-panels class="provenance">
          <v-expansion-panel v-model="provenanceOpen">
            <v-expansion-panel-title>Record details</v-expansion-panel-title>
            <v-expansion-panel-text>
              <dl class="attributes">
                <template v-for="attribute in PROVENANCE_ATTRIBUTES" :key="attribute.field">
                  <dt>{{ attribute.label }}</dt>
                  <dd class="provenance-value">
                    <a
                      v-if="attribute.field === 'url'"
                      :href="provenanceValue(attribute.field)"
                      rel="noreferrer"
                      target="_blank"
                      >{{ provenanceValue(attribute.field) }}</a
                    ><template v-else>{{ provenanceValue(attribute.field) }}</template>
                  </dd>
                </template>
              </dl>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </template>
    </template>
  </section>
</template>

<style scoped>
.detail {
  block-size: 100%;
  min-block-size: 0;
  overflow-y: auto;
  padding: 1.5rem clamp(1rem, 4vw, 4rem);
}
.welcome {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 8vh auto;
  max-inline-size: 38rem;
}
.welcome h1,
.detail-header h1 {
  color: rgb(var(--v-theme-on-surface));
  font-size: clamp(1.75rem, 4vw, 3rem);
  line-height: 1.1;
  margin: 0.25rem 0 0.5rem;
}
.eyebrow {
  color: rgb(var(--v-theme-primary));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  margin: 0;
  text-transform: uppercase;
}
.episode {
  color: rgb(var(--v-theme-secondary));
  font-weight: 600;
  margin: 0;
}
.breadcrumb {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  margin-block-end: 1.5rem;
}
.separator {
  color: rgb(var(--v-theme-on-surface-variant));
}
.attribute-group {
  margin-block: 2rem;
}
.section-heading {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}
.attributes {
  display: grid;
  gap: 0.5rem 1rem;
  grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr);
  margin: 0;
}
.attributes dt {
  color: rgb(var(--v-theme-on-surface-variant));
}
.attributes dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.missing,
.provenance-value {
  color: rgb(var(--v-theme-on-surface-variant));
}
.long {
  white-space: pre-wrap;
}
.relations,
.provenance {
  margin-block: 1rem;
}
.relation-count {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin-inline-start: 0.5rem;
}
.empty-relation {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}
@media (max-width: 600px) {
  .attributes {
    grid-template-columns: 1fr;
    gap: 0.15rem;
  }
  .attributes dd {
    margin-block-end: 0.75rem;
  }
}
</style>
