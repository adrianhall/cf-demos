<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { GraphQLRequestError } from '../api/graphql-client';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import { explorerLocation } from '../router';
import type { EntitySummary } from '../stores/catalog';
import { useCatalogStore } from '../stores/catalog';
import { useExplorerStore } from '../stores/explorer';
import { useSessionStore } from '../stores/session';

const catalog = useCatalogStore();
const explorer = useExplorerStore();
const session = useSessionStore();
const router = useRouter();
const searchInput = useTemplateRef('searchInput');
const term = ref('');
const open = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const groups = ref<{ typeId: EntityTypeId; matches: EntitySummary[] }[]>([]);
let controller: AbortController | undefined;

const hasTerm = computed(() => term.value.trim().length > 0);

function focusGlobalSearch(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    searchInput.value?.focus();
  }
}

function close(): void {
  open.value = false;
}

async function choose(typeId: EntityTypeId, item: EntitySummary): Promise<void> {
  // Global search starts a new line of enquiry (UISPEC §7), not a continuation of whatever
  // relation path happened to be open underneath the results popover. The selected entity still
  // needs its collection as the first breadcrumb step, so restore both explicitly.
  explorer.restoreTrail([
    { typeId, entityId: null, label: ENTITY_TYPES[typeId].label },
    { typeId, entityId: item.id, label: item.title }
  ]);
  await router.push(explorerLocation(typeId, item.id, explorer.trail));
  close();
}

watch(term, async (value, _previous, onCleanup) => {
  controller?.abort();
  groups.value = [];
  error.value = null;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    loading.value = false;
    return;
  }

  const request = new AbortController();
  controller = request;
  onCleanup(() => request.abort());
  loading.value = true;
  open.value = true;
  try {
    groups.value = await catalog.searchEverything(trimmed, request.signal);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return;
    }
    if (cause instanceof GraphQLRequestError && cause.kind === 'unauthenticated') {
      session.markExpired();
    }
    error.value = 'Search is unavailable right now.';
  } finally {
    if (controller === request) {
      loading.value = false;
    }
  }
});

onMounted(() => window.addEventListener('keydown', focusGlobalSearch));
onBeforeUnmount(() => {
  controller?.abort();
  window.removeEventListener('keydown', focusGlobalSearch);
});
</script>

<template>
  <v-app-bar class="banner" density="comfortable" flat>
    <v-btn aria-label="SWAPI Explorer home" class="brand" to="/" variant="text"
      >SWAPI Explorer</v-btn
    >
    <v-menu
      v-model="open"
      :close-on-content-click="false"
      location="bottom"
      max-width="40rem"
      width="min(40rem, calc(100vw - 2rem))"
    >
      <template #activator="{ props }">
        <v-text-field
          ref="searchInput"
          v-bind="props"
          v-model="term"
          aria-label="Search all Star Wars records"
          class="global-search"
          clearable
          density="compact"
          hide-details
          placeholder="Search everything"
          prepend-inner-icon="mdi-magnify"
          variant="outlined"
          @click="open = hasTerm"
          @keydown.esc="close"
        >
          <template #append-inner><kbd class="shortcut">⌘K</kbd></template>
        </v-text-field>
      </template>
      <v-card class="search-results">
        <v-progress-linear v-if="loading" color="primary" indeterminate />
        <v-card-text v-if="error" class="muted">{{ error }}</v-card-text>
        <v-card-text v-else-if="!loading && groups.length === 0" class="muted">
          No records match “{{ term }}”.
        </v-card-text>
        <template v-for="group in groups" :key="group.typeId">
          <div class="result-heading">{{ ENTITY_TYPES[group.typeId].label }}</div>
          <v-list density="compact">
            <v-list-item
              v-for="item in group.matches"
              :key="item.id"
              @click="void choose(group.typeId, item)"
            >
              <v-list-item-title>{{ item.title }}</v-list-item-title>
              <v-list-item-subtitle>{{ item.subtitle }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </template>
      </v-card>
    </v-menu>
    <!--
      GraphiQL is the explorer's technical sibling, not a hidden implementation detail. Keeping a
      persistent link in the banner makes the hand-off available from every record, not only from
      the welcome state, and leaves `/graphql` as the stable address someone can bookmark.
    -->
    <v-btn aria-label="Open GraphiQL" class="graphiql-link" href="/graphql" variant="text">
      GraphiQL
    </v-btn>
    <div class="spacer" />
    <span v-if="session.email" class="identity">{{ session.email }}</span>
    <span v-else-if="session.loading" class="identity">Verifying identity…</span>
    <v-btn href="/cdn-cgi/access/logout" variant="text">Sign out</v-btn>
  </v-app-bar>
  <v-alert v-if="session.expired" class="session-alert" density="compact" type="warning">
    Your session has expired. <a :href="$route.fullPath">Sign in again</a> to continue where you
    were.
  </v-alert>
</template>

<style scoped>
.banner {
  border-block-end: 1px solid rgb(var(--v-theme-outline-variant));
}
.brand {
  font-weight: 750;
  letter-spacing: 0.02em;
  text-transform: none;
}
.global-search {
  /*
   * VAppBar's flex children otherwise stretch to its full 56px content height. A vertical margin
   * gives the outlined field breathing room and makes it read as an input *in* the banner rather
   * than as the banner's full-height border. Explicit compact density keeps its touch target
   * comfortably usable while making the visual control materially tighter.
   */
  margin-block: 0.375rem;
  margin-inline-start: 1rem;
  max-inline-size: 32rem;
}
.graphiql-link {
  margin-inline-start: 0.5rem;
  text-transform: none;
}
.shortcut {
  color: rgb(var(--v-theme-on-surface-variant));
  font: inherit;
  font-size: 0.75rem;
}
.spacer {
  flex: 1;
}
.identity {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin-inline: 1rem;
  overflow-wrap: anywhere;
}
.search-results {
  max-block-size: min(30rem, 65vh);
  overflow-y: auto;
}
.result-heading {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 1rem 1rem 0.25rem;
  text-transform: uppercase;
}
.muted {
  color: rgb(var(--v-theme-on-surface-variant));
}
.session-alert {
  inset-inline: 1rem;
  position: fixed;
  top: 4.5rem;
  z-index: 2000;
}
@media (max-width: 700px) {
  .identity {
    display: none;
  }
  .global-search {
    margin-inline-start: 0.25rem;
  }
}
</style>
