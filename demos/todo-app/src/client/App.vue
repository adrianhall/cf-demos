<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionStore } from "./stores/session";

const session = useSessionStore();

/** Retrieve the verified Access identity once the application is mounted. */
onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <v-main>
      <header class="app-header">
        <span class="app-name">Tasks</span>
        <span v-if="session.email" class="identity">{{ session.email }}</span>
        <span v-else-if="session.loading" class="identity">Verifying identity…</span>
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
