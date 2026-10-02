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
    <!--
      First focusable control in the document. The sidebar has fifteen panel links and stacks above
      the content on a narrow screen, so landmarks alone help a screen-reader user but still make a
      sighted keyboard user traverse the whole list on every route.
    -->
    <a class="skip-link" href="#main-content">Skip to main content</a>

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
          <!--
              Where a panel teleports its title and info button. Declared before `router-view` so
              the target exists by the time a panel's deferred teleport resolves; the panel owns
              what goes in it, and the bar is empty on a route that supplies nothing.

              The title lives here rather than in the panel body because it was the first of five
              equally-weighted blocks pushing the actual work below the fold. In the bar it is
              still the most prominent text on the page without costing the content any vertical
              space.
            -->
          <div id="panel-title-slot" class="panel-title-slot"></div>
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
        <!--
            The one and only main landmark. `v-main` rendered a second outer `<main>` around the
            entire shell, which nested the sidebar inside main content and left two main landmarks
            for assistive technology to choose between.
          -->
        <main id="main-content" tabindex="-1">
          <router-view />
        </main>
      </div>
    </div>
  </v-app>
</template>

<style scoped>
/*
  Off screen until focused, then placed above the shell. The sidebar can contain fifteen links, so
  this is the sighted-keyboard equivalent of the landmarks a screen reader can jump between.
*/
.skip-link {
  background-color: rgb(var(--v-theme-primary));
  border-radius: 0 0 0.375rem 0;
  color: rgb(var(--v-theme-background));
  left: 0;
  padding: 0.625rem 0.875rem;
  position: fixed;
  top: 0;
  transform: translateY(-150%);
  transition: transform 120ms ease;
  z-index: 3000;
}

.skip-link:focus {
  outline: 2px solid rgb(var(--v-theme-on-surface));
  outline-offset: 2px;
  transform: translateY(0);
}

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

/*
  `justify-content` is gone: the title slot takes the free space with `flex: 1 1 auto`, which
  pushes the identity and sign-out to the right without the two rules fighting over alignment.
*/
.topbar {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
}

/*
  `min-width: 0` so the panel title inside can truncate instead of forcing the bar wider than the
  viewport — a flex child otherwise refuses to shrink below its content's intrinsic width.
*/
.panel-title-slot {
  flex: 1 1 auto;
  min-width: 0;
}

.identity {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
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
@media (prefers-reduced-motion: reduce) {
  .skip-link {
    transition: none;
  }
}

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
