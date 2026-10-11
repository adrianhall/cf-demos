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
  mdiCardAccountDetailsOutline,
  mdiBriefcase,
  mdiChartBar,
  mdiCheckboxMarkedCircleOutline,
  mdiDomain,
  mdiFormatListChecks,
  mdiChevronDown,
  mdiHistory,
  mdiLogout,
  mdiMenu,
  mdiNoteTextOutline,
  mdiViewDashboard,
  mdiViewColumn
} from '@mdi/js';
import type { Permission } from '../shared/permissions.ts';
import { useAnnouncement } from './composables/useAnnouncer.ts';
import { useSession } from './composables/useSession.ts';
import { primaryRole, ROLE_ICONS } from './services/roles.ts';

const { session, state, error, roleLabel, load, can } = useSession();
/**
 * Icon for the signed-in user's most privileged role.
 */
const roleIcon = computed(
  () => ROLE_ICONS[primaryRole(session.value?.roles.map((role) => role.id) ?? [])]
);
const { mdAndUp } = useDisplay();
const route = useRoute();
const announcement = useAnnouncement();
const router = useRouter();
const navigating = ref(false);
const chunkError = ref(false);
const drawer = ref<boolean | null>(null);
/**
 * Whether the navigation drawer is showing. `null` means Vuetify has not decided yet, which it
 * resolves to open on wide screens and closed on narrow ones.
 */
const drawerOpen = computed(() => drawer.value ?? mdAndUp.value);
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

// `route.path`, not `fullPath`: filter pages rewrite only the query string as the user types or
// chooses, and stealing focus to the heading in the middle of filtering would undo their work.
watch(
  () => route.path,
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
    <div class="sr-only" role="status" aria-live="polite" data-testid="announcer">
      {{ announcement }}
    </div>
    <v-app-bar color="primary" density="comfortable">
      <template #prepend>
        <v-app-bar-nav-icon
          :icon="mdiMenu"
          aria-label="Toggle navigation"
          aria-controls="main-navigation"
          :aria-expanded="drawerOpen ? 'true' : 'false'"
          @click="drawer = !drawerOpen"
        />
      </template>
      <v-app-bar-title>Ignite CRM</v-app-bar-title>
      <template v-if="session" #append>
        <v-menu location="bottom end">
          <template #activator="{ props: menu }">
            <v-btn
              v-bind="menu"
              variant="text"
              class="mr-1 text-none"
              :prepend-icon="roleIcon"
              :append-icon="mdiChevronDown"
              :aria-label="`Account menu: ${session.user.displayName}, ${roleLabel}`"
              data-testid="identity"
            >
              <span class="d-flex flex-column align-start text-left identity-text">
                <span class="text-body-2">{{ session.user.displayName }}</span>
                <span class="text-caption">{{ roleLabel }}</span>
              </span>
            </v-btn>
          </template>
          <v-list density="compact" aria-label="Account">
            <v-list-item
              :title="session.user.displayName"
              :subtitle="session.user.email"
              data-testid="account-summary"
            />
            <v-list-item
              :to="{ name: 'account' }"
              :prepend-icon="mdiCardAccountDetailsOutline"
              title="Your account"
            />
            <v-list-item href="/cdn-cgi/access/logout" :prepend-icon="mdiLogout" title="Sign out" />
          </v-list>
        </v-menu>
      </template>
    </v-app-bar>

    <v-navigation-drawer id="main-navigation" v-model="drawer" aria-label="Main navigation">
      <v-list nav role="group" aria-label="Pages">
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

<style>
/*
 * Links inside the app use the theme's strong brand tone instead of the browser default (blue),
 * which is about 1.6:1 on the dark background. `primary-strong` is 5.6:1 in light and 9.9:1 in dark
 * (see the theme notes in vuetify.ts). Not scoped: it is a global typography rule.
 */
.v-application a:not(.v-btn):not(.v-list-item):not(.v-chip):not(.v-breadcrumbs-item--link) {
  color: rgb(var(--v-theme-primary-strong));
}

/*
 * Required fields carry the native `required` attribute (announced by screen readers; the forms
 * use `novalidate`, so the browser never blocks submission) and show a visible asterisk after
 * their label (WCAG 3.3.2). The forms' introductions do not explain the asterisk because the
 * required state is also announced and every error names the missing field.
 */
.v-input:has(input[required], textarea[required]) .v-label::after {
  /* Empty alternative text: the native `required` state is announced, so the asterisk is visual
     only and the field's accessible name stays exactly its label. */
  content: ' *';
  content: ' *' / '';
}

/*
 * Vuetify dims list subtitles with `opacity`, which also dims any link inside them below 4.5:1.
 * Dim the text colour instead, so a subtitle link keeps its full `primary-strong` contrast.
 */
.v-list-item-subtitle {
  --v-list-item-subtitle-opacity: 1;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

/*
 * The current page in a breadcrumb trail is “disabled” (not a link), and Vuetify fades it with the
 * disabled opacity on top of high emphasis. Show it as plain medium-emphasis text instead.
 */
.v-breadcrumbs-item--disabled {
  opacity: 1;
  color: rgba(var(--v-theme-on-background), var(--v-medium-emphasis-opacity));
}

/* Keep focused controls clear of the sticky app bar (WCAG 2.4.11). */
html {
  scroll-padding-top: 80px;
}
</style>

<style scoped>
/* On a phone the account button shows only its role icon; the name stays in its accessible name. */
@media (max-width: 599.98px) {
  .identity-text {
    display: none !important;
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

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
