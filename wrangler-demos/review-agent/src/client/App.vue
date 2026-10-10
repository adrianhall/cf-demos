<script setup lang="ts">
import { onMounted } from "vue";
import { useSessionStore } from "./stores/session";

/**
 * The app shell: the identity header (verified Cloudflare Access email plus an unconditional
 * `/cdn-cgi/access/logout` control -- docs/07-PR-REVIEW-AGENT.md, "Access Model" and
 * Implementation Plan Phase 6, item 25) and the routed view. Rendered once, here, rather than
 * duplicated per view, mirroring `demos/agentic-ai-chat/src/client/App.vue`'s own layout.
 */
const session = useSessionStore();

onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <v-main>
      <header class="app-header">
        <router-link class="app-name" to="/">PR Review Agent</router-link>
        <span v-if="session.email" class="identity">{{ session.email }}</span>
        <span v-else-if="session.loading" class="identity">Verifying identity…</span>
        <span v-else-if="session.error" class="identity notice-error" role="alert">
          {{ session.error }}
        </span>
        <!--
          Unconditional sign-out control, per AGENTS.md's "Public Access" guidance: rendered
          regardless of the current identity's authorization, so signing in as the wrong
          identity during local development always has a recovery besides clearing cookies by
          hand.
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
.app-header {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 0 auto;
  max-width: 64rem;
  padding: 1rem;
}

.app-name {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 700;
  text-decoration: none;
}

.app-name:hover,
.app-name:focus-visible {
  text-decoration: underline;
}

.identity {
  color: rgb(var(--v-theme-on-surface));
  margin-left: auto;
  overflow-wrap: anywhere;
}

.notice-error {
  color: rgb(var(--v-theme-error));
  font-weight: 600;
}

.logout-button {
  flex: 0 0 auto;
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
