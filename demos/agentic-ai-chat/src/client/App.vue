<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionStore } from "./stores/session";

const session = useSessionStore();

/** Retrieve the verified Access identity (and D1 administrator role) once mounted. */
onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <v-main>
      <header class="app-header">
        <span class="app-name">Agentic Chat</span>
        <span v-if="session.email" class="identity">
          {{ session.email }}
          <span v-if="session.isAdmin" class="admin-badge">Administrator</span>
        </span>
        <span v-else-if="session.loading" class="identity">Verifying identity…</span>
        <router-link v-if="session.isAdmin" class="admin-link" to="/admin">
          Admin console
        </router-link>
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

.admin-badge {
  background: rgb(var(--v-theme-primary));
  border-radius: 0.75rem;
  color: rgb(var(--v-theme-surface));
  font-size: 0.75rem;
  font-weight: 700;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  text-transform: uppercase;
}

.admin-link {
  color: rgb(var(--v-theme-secondary));
  flex: 0 0 auto;
  font-weight: 600;
  text-decoration: none;
}

.admin-link:hover,
.admin-link:focus-visible {
  text-decoration: underline;
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
