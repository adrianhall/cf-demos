<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
/**
 * Application shell: skip link, app bar with identity, responsive navigation drawer, and the routed
 * main landmark. Focus moves to the main region's first heading after each route change, so
 * keyboard and screen-reader users land on the new page's content.
 *
 * Most views are lazily loaded chunks (`router/index.ts`). While a view's chunk downloads, a thin
 * progress bar under the app bar shows that navigation is in progress; if the chunk cannot be
 * fetched (typically after a new deployment replaced the hashed files), an alert explains and
 * offers a full reload instead of leaving the user on a page that silently did not change.
 */
import {
  mdiAccountGroup,
  mdiAccountMultiple,
  mdiBriefcase,
  mdiChartBar,
  mdiCheckboxMarkedCircleOutline,
  mdiDomain,
  mdiFormatListChecks,
  mdiHistory,
  mdiMenu,
  mdiNoteTextOutline,
  mdiViewDashboard,
  mdiViewColumn
} from '@mdi/js';
import type { Permission } from '../shared/permissions.ts';
import { useSession } from './composables/useSession.ts';

const { session, state, error, roleLabel, load, can } = useSession();
const { mdAndUp } = useDisplay();
const route = useRoute();
const router = useRouter();
const navigating = ref(false);
const chunkError = ref(false);
const drawer = ref<boolean | null>(null);
const main = ref<{ $el: HTMLElement } | null>(null);

const navigation = [
  { title: 'Dashboard', icon: mdiViewDashboard, to: { name: 'dashboard' } },
  { title: 'Action stream', icon: mdiFormatListChecks, to: { name: 'actions' } },
  { title: 'Deals', icon: mdiBriefcase, to: { name: 'deals' } },
  { title: 'Projects', icon: mdiViewColumn, to: { name: 'projects' } },
  { title: 'My work', icon: mdiCheckboxMarkedCircleOutline, to: { name: 'my-work' } },
  { title: 'Notes', icon: mdiNoteTextOutline, to: { name: 'notes' } },
  { title: 'Contacts', icon: mdiAccountMultiple, to: { name: 'contacts' } },
  { title: 'Companies', icon: mdiDomain, to: { name: 'companies' } },
  { title: 'Reports', icon: mdiChartBar, to: { name: 'reports' }, needs: 'report.read' },
  // Shown only when the session's capability hints allow; the API refuses the rest anyway.
  { title: 'Team', icon: mdiAccountGroup, to: { name: 'team' }, needs: 'users.read' },
  { title: 'Audit trail', icon: mdiHistory, to: { name: 'audit' }, needs: 'audit.read' }
] as const satisfies readonly { title: string; needs?: Permission }[];

/**
 * Navigation items the signed-in user can use.
 */
const visibleNavigation = computed(() =>
  navigation.filter((item) => !('needs' in item) || can(item.needs))
);

watch(
  () => route.fullPath,
  async (_now, before) => {
    if (before === undefined) {
      return;
    }
    if (!mdAndUp.value) {
      drawer.value = false;
    }
    await nextTick();
    const heading = main.value?.$el.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  }
);

const removeGuards = [
  router.beforeEach(() => {
    navigating.value = true;
    chunkError.value = false;
  }),
  router.afterEach(() => {
    navigating.value = false;
  }),
  router.onError(() => {
    // Lazy route components are the only asynchronous part of navigation, so a navigation error
    // here means a view's chunk could not be loaded.
    navigating.value = false;
    chunkError.value = true;
  })
];
onBeforeUnmount(() => {
  for (const remove of removeGuards) {
    remove();
  }
});

/**
 * Reload the page so the browser fetches the current deployment's chunks.
 */
function reloadPage(): void {
  window.location.reload();
}

onMounted(() => void load());
</script>

<template>
  <v-app>
    <a href="#main" class="skip-link">Skip to content</a>
    <v-app-bar color="primary" density="comfortable">
      <template #prepend>
        <v-app-bar-nav-icon
          :icon="mdiMenu"
          aria-label="Toggle navigation"
          @click="drawer = !drawer"
        />
      </template>
      <v-app-bar-title>Ignite CRM</v-app-bar-title>
      <template v-if="session" #append>
        <div class="text-right mr-2" data-testid="identity">
          <div class="text-body-2">{{ session.user.displayName }}</div>
          <div class="text-caption">{{ roleLabel }}</div>
        </div>
      </template>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" aria-label="Main navigation">
      <v-list nav>
        <v-list-item
          v-for="item in visibleNavigation"
          :key="item.title"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.title"
        />
      </v-list>
    </v-navigation-drawer>

    <v-main id="main" ref="main">
      <v-progress-linear
        :active="navigating"
        indeterminate
        absolute
        color="primary-strong"
        aria-label="Loading page"
      />
      <v-container class="py-6">
        <v-alert
          v-if="chunkError"
          type="error"
          variant="tonal"
          role="alert"
          class="mb-4"
          title="This page could not be loaded"
        >
          Part of the app failed to download, usually because a newer version was just deployed.
          <template #append><v-btn variant="text" @click="reloadPage">Reload</v-btn></template>
        </v-alert>
        <v-progress-linear
          v-if="state === 'loading' || state === 'idle'"
          indeterminate
          aria-label="Loading your session"
        />
        <v-alert
          v-else-if="state === 'error'"
          type="error"
          variant="tonal"
          role="alert"
          title="Could not sign you in"
        >
          {{ error?.message }}
          <template #append><v-btn variant="text" @click="load()">Retry</v-btn></template>
        </v-alert>
        <router-view v-else />
      </v-container>
    </v-main>
  </v-app>
</template>

<style scoped>
.skip-link {
  position: absolute;
  left: -10000px;
  top: 0;
  z-index: 10000;
  padding: 0.75rem 1rem;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}

.skip-link:focus {
  left: 0.5rem;
  top: 0.5rem;
}
</style>
