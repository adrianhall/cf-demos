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
        <span class="app-name">Chat</span>
        <span v-if="session.email" class="identity">{{ session.email }}</span>
        <span v-else-if="session.loading" class="identity">Verifying identity…</span>
        <a class="logout-link" href="/cdn-cgi/access/logout">Sign out</a>
      </header>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.app-header {
  align-items: center;
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  display: flex;
  gap: 1rem;
  height: 4rem;
  padding: 0 1rem;
}

.app-name {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
}

.identity {
  color: rgb(var(--v-theme-on-surface));
  margin-left: auto;
  overflow-wrap: anywhere;
}

.logout-link {
  color: rgb(var(--v-theme-primary));
  flex: 0 0 auto;
  font-weight: 600;
}

@media (max-width: 600px) {
  .identity {
    display: none;
  }
}
</style>
