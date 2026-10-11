<script setup lang="ts">
/**
 * Audit trail: who changed what, and when, across every module — for owners and managers.
 *
 * Built from Vuetify's `VDataTable`, `VSelect`, and `VChip`. Filters (module, record type, person,
 * and a specific record) live in the URL, so a filtered trail can be bookmarked or linked from a
 * record page. Events are newest first and paged with "Load more". Metadata is the server's
 * allowlisted projection — ids, field names, statuses, counts, and digests — and is rendered as
 * plain text; a note's body never appears here, only its SHA-256 digest.
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AUDIT_ENTITY_TYPES,
  AUDIT_MODULES,
  type AuditEntityType,
  type AuditEvent,
  type AuditModuleName
} from '../../shared/api/audit.ts';
import type { TeamMember } from '../../shared/api/team.ts';
import ResourceState from '../components/ResourceState.vue';
import { useFormat } from '../composables/useFormat.ts';
import { useResource } from '../composables/useResource.ts';
import { api } from '../services/api-client.ts';

const route = useRoute();
const router = useRouter();
const format = useFormat();

/**
 * Display names for modules.
 */
const MODULE_LABELS: Readonly<Record<AuditModuleName, string>> = {
  crm: 'CRM',
  projects: 'Projects',
  notes: 'Notes',
  permissions: 'Team'
};

/**
 * Display names for record types.
 */
const TYPE_LABELS: Readonly<Record<AuditEntityType, string>> = {
  contact: 'Contact',
  company: 'Company',
  deal: 'Deal',
  activity: 'Activity',
  project: 'Project',
  task: 'Task',
  note: 'Note',
  user: 'Teammate'
};

/**
 * Record types that have their own page.
 */
const ROUTED: Readonly<Partial<Record<string, string>>> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
  project: 'project',
  note: 'note'
};

/**
 * A query value if it is one of the allowed strings.
 *
 * @param value The raw query value.
 * @param allowed Allowed values.
 * @returns The value, or `null`.
 */
function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

const moduleFilter = ref<AuditModuleName | null>(pick(route.query.module, AUDIT_MODULES));
const typeFilter = ref<AuditEntityType | null>(pick(route.query.entityType, AUDIT_ENTITY_TYPES));
const actorFilter = ref<string | null>(
  typeof route.query.actorId === 'string' ? route.query.actorId : null
);
const entityFilter = ref<string | null>(
  typeof route.query.entityId === 'string' ? route.query.entityId : null
);

const people = shallowRef<TeamMember[]>([]);
const events = shallowRef<AuditEvent[]>([]);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);

/**
 * The active filters as an API query.
 *
 * @returns Defined filters only.
 */
function filters(): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      module: moduleFilter.value,
      entityType: typeFilter.value,
      entityId: entityFilter.value,
      actorId: actorFilter.value
    }).filter((entry): entry is [string, string] => entry[1] !== null)
  );
}

const trail = useResource(async (signal) => {
  const page = await api.audit(filters(), signal);
  events.value = [...page.items];
  nextCursor.value = page.nextCursor;
  return page;
});

const headers = [
  { title: 'When', key: 'occurredAt', sortable: false },
  { title: 'Who', key: 'actor', sortable: false },
  { title: 'What', key: 'action', sortable: false },
  { title: 'Record', key: 'entity', sortable: false },
  { title: 'Details', key: 'metadata', sortable: false }
];

const moduleItems = AUDIT_MODULES.map((value) => ({ title: MODULE_LABELS[value], value }));
const typeItems = AUDIT_ENTITY_TYPES.map((value) => ({ title: TYPE_LABELS[value], value }));
const peopleItems = computed(() =>
  people.value.map((member) => ({ title: member.displayName, value: member.id }))
);

/**
 * Append the next page.
 */
async function loadMore(): Promise<void> {
  if (nextCursor.value === null) {
    return;
  }
  loadingMore.value = true;
  try {
    const page = await api.audit({ ...filters(), cursor: nextCursor.value });
    events.value = [...events.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

/**
 * Clear every filter.
 */
function clearFilters(): void {
  moduleFilter.value = null;
  typeFilter.value = null;
  actorFilter.value = null;
  entityFilter.value = null;
}

/**
 * A readable label for a record type.
 *
 * @param type The stored type.
 * @returns Its label, or the raw type.
 */
function typeLabel(type: string): string {
  return (TYPE_LABELS as Record<string, string>)[type] ?? type;
}

/**
 * Metadata as `key: value` text, shortening digests so a long hash does not crowd the row.
 *
 * @param event The event.
 * @returns One string per entry.
 */
function details(event: AuditEvent): string[] {
  return Object.entries(event.metadata).map(([key, value]) =>
    key === 'digest' && typeof value === 'string'
      ? `digest: ${value.slice(0, 12)}…`
      : `${key}: ${value === null ? '—' : String(value)}`
  );
}

watch([moduleFilter, typeFilter, actorFilter, entityFilter], async () => {
  await router.replace({ query: filters() });
  await trail.load();
});

onMounted(async () => {
  await trail.load();
  // The person filter needs the directory; owners and managers both have it.
  people.value = await api
    .team({})
    .then((page) => [...page.items])
    .catch(() => []);
});
</script>

<template>
  <section aria-labelledby="audit-title">
    <h1 id="audit-title" class="text-h4 mb-1">Audit trail</h1>
    <p class="text-medium-emphasis mb-4">
      Every change, newest first. Details show identifiers, fields, statuses, and content digests —
      never note text.
    </p>
    <v-row density="compact" class="mb-2" role="group" aria-label="Filters">
      <v-col cols="12" sm="6" md="3">
        <v-select v-model="moduleFilter" :items="moduleItems" label="Area" clearable hide-details />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-select
          v-model="typeFilter"
          :items="typeItems"
          label="Record type"
          clearable
          hide-details
        />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-select
          v-model="actorFilter"
          :items="peopleItems"
          label="Person"
          clearable
          hide-details
        />
      </v-col>
      <v-col cols="12" sm="6" md="3" class="d-flex align-center ga-2">
        <v-chip
          v-if="entityFilter"
          closable
          close-label="Show every record"
          @click:close="entityFilter = null"
          >One record</v-chip
        >
        <v-btn variant="text" @click="clearFilters">Clear filters</v-btn>
      </v-col>
    </v-row>
    <ResourceState
      :state="trail.state.value"
      :error="trail.error.value"
      :empty="events.length === 0"
      :has-data="trail.data.value !== null"
      skeleton="table"
      empty-title="No matching changes"
      empty-text="Try removing a filter."
      @retry="trail.load"
    >
      <v-card>
        <v-data-table
          :headers="headers"
          :items="events"
          item-value="id"
          :items-per-page="-1"
          hide-default-footer
          aria-label="Audit events"
          mobile-breakpoint="0"
        >
          <template #[`item.occurredAt`]="{ item }">{{
            format.dateTime(item.occurredAt)
          }}</template>
          <template #[`item.actor`]="{ item }">{{ item.actor.displayName }}</template>
          <template #[`item.action`]="{ item }">
            <v-chip size="small" variant="tonal">{{ MODULE_LABELS[item.module] }}</v-chip>
            <span class="ms-2">{{ item.action }}</span>
          </template>
          <template #[`item.entity`]="{ item }">
            <span class="text-medium-emphasis">{{ typeLabel(item.entityType) }}:</span>
            <router-link
              v-if="ROUTED[item.entityType] && item.entityLabel !== null"
              :to="{ name: ROUTED[item.entityType]!, params: { id: item.entityId } }"
              class="text-primary-strong ms-1"
              >{{ item.entityLabel }}</router-link
            >
            <span v-else class="ms-1">{{ item.entityLabel ?? 'Unavailable record' }}</span>
          </template>
          <template #[`item.metadata`]="{ item }">
            <div class="d-flex flex-wrap ga-1" data-testid="audit-details">
              <v-chip v-for="text in details(item)" :key="text" size="x-small" label>{{
                text
              }}</v-chip>
              <v-chip v-if="item.redacted" size="x-small" label color="warning">redacted</v-chip>
            </div>
          </template>
        </v-data-table>
      </v-card>
      <div v-if="nextCursor" class="d-flex justify-center mt-2">
        <v-btn variant="tonal" :loading="loadingMore" @click="loadMore">Load more</v-btn>
      </div>
    </ResourceState>
  </section>
</template>
