<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from './stores/session';

const session = useSessionStore();

/**
 * Retrieve the verified Access identity once the application is mounted.
 *
 * The promise is intentionally discarded with `void`: the store records its own failure in
 * `session.error` and the header simply shows nothing rather than blocking the task list.
 */
onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <v-main>
      <header class="app-header">
        <span class="app-name">Tasks</span>
        <span v-if="session.email" class="identity">{{ session.email }}</span>
        <span v-else-if="session.loading" class="identity">Verifying identity…</span>
        <!--
          A plain link to Cloudflare Access's own logout endpoint rather than any application
          state: the session lives in the Access cookie, so signing out is Access's job. Visible at
          all times because switching identity is the point of this demo.
        -->
        <v-btn class="logout-button" href="/cdn-cgi/access/logout" variant="outlined">
          Sign out
        </v-btn>
      </header>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.logout-button {
  flex: 0 0 auto;
}

.app-header {
  align-items: center;
  display: flex;
  gap: 1rem;
  margin: 0 auto;
  max-width: 56rem;
  padding: 1rem;
}

.app-name {
  font-weight: 700;
}

.identity {
  color: rgb(var(--v-theme-on-surface));
  margin-left: auto;
  overflow-wrap: anywhere;
}

@media (max-width: 600px) {
  .app-header {
    align-items: flex-start;
  }

  .identity {
    margin-left: 0;
  }
}
</style>
