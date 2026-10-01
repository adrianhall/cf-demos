<script setup lang="ts">
import { onMounted } from 'vue';
import PanelNavigation from './components/shell/PanelNavigation.vue';
import SessionCostMeter from './components/shell/SessionCostMeter.vue';
import { useSessionStore } from './stores/session';

const session = useSessionStore();

/**
 * Retrieve the verified Access identity once the application is mounted.
 *
 * The promise is intentionally discarded with `void`: the store records its own failure in
 * `session.error` and the header simply shows nothing rather than blocking the panels.
 */
onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <v-main>
      <div class="shell">
        <!--
          The sidebar is a landmark of its own so a keyboard or screen-reader user can jump
          straight to the panel list or straight past it, rather than tabbing through fifteen
          links to reach the content every time.
        -->
        <aside class="sidebar">
          <div class="brand">
            <span class="brand-name">Playground</span>
            <span class="brand-tagline">Every request through AI Gateway</span>
          </div>
          <PanelNavigation />
          <SessionCostMeter />
        </aside>

        <div class="content">
          <header class="topbar">
            <span v-if="session.email" class="identity">{{ session.email }}</span>
            <span v-else-if="session.loading" class="identity">Verifying identity…</span>
            <!--
              A plain link to Cloudflare Access's own logout endpoint rather than any application
              state: the session lives in the Access cookie, so signing out is Access's job.
              Visible at all times, including before the identity resolves, because a visitor who
              cannot verify their session is exactly the one who most wants to sign out and retry.
            -->
            <v-btn class="logout-button" href="/cdn-cgi/access/logout" variant="outlined">
              Sign out
            </v-btn>
          </header>
          <main>
            <router-view />
          </main>
        </div>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  background-color: rgb(var(--v-theme-surface));
  border-right: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  flex: 0 0 17rem;
  flex-direction: column;
}

.brand {
  display: flex;
  flex-direction: column;
  padding: 1.25rem 1.25rem 0.5rem;
}

.brand-name {
  font-size: 1.25rem;
  font-weight: 700;
}

.brand-tagline {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.topbar {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  padding: 0.75rem 1.25rem;
}

.identity {
  overflow-wrap: anywhere;
}

.logout-button {
  flex: 0 0 auto;
}

/*
  Below the tablet breakpoint the sidebar stacks above the content rather than disappearing behind
  a toggle. Fifteen links is a long list, but a visible list a visitor can scroll past beats a
  hidden one they have to discover.
*/
@media (max-width: 960px) {
  .shell {
    flex-direction: column;
  }

  .sidebar {
    border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
    border-right: none;
    flex: 0 0 auto;
  }
}
</style>
